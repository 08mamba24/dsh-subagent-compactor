#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildComboDigest,
	classifyInstallFailure,
	classifyRunnerResult,
	extractSupportedVersions,
	sanitizeReportText,
	sha256,
} from "./lib/upstream-compat-core.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!command) throw new Error("Expected a command: prepare, run, reuse, cache, or aggregate");
	const values = { command };
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		const value = rest[index + 1];
		if (!arg.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${arg}`);
		values[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
		index++;
	}
	return values;
}

function required(args, ...names) {
	for (const name of names) if (!args[name]) throw new Error(`--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
}

function absolute(path, name) {
	if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
	return resolve(path);
}

function writeGithubOutput(path, name, value) {
	if (!path) return;
	const text = String(value);
	if (/\r|\n/.test(text)) throw new Error(`GitHub output ${name} must be one line`);
	appendFileSync(path, `${name}=${text}\n`);
}

function saveReport(path, report, githubOutput) {
	writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
	writeGithubOutput(githubOutput, "classification", report.classification);
	writeGithubOutput(githubOutput, "reason", report.reason);
	return report;
}

function safeEnvironment(home) {
	const npmrc = join(home, ".npmrc");
	mkdirSync(home, { recursive: true });
	if (!existsSync(npmrc)) writeFileSync(npmrc, "audit=false\nfund=false\n");
	return {
		PATH: process.env.PATH,
		TMPDIR: process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp",
		LANG: process.env.LANG || "C.UTF-8",
		LC_ALL: process.env.LC_ALL || "",
		HOME: home,
		NO_PROXY: "127.0.0.1,localhost,::1",
		NPM_CONFIG_USERCONFIG: npmrc,
		CI: "true",
	};
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (output) process.stdout.write(output);
	return { ...result, output };
}

function outputTail(output, limit = 12_000) {
	return output.replace(/\u001b\[[0-9;]*m/g, "").slice(-limit);
}

function firstFailure(output) {
	const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
	return sanitizeReportText(clean.split(/\r?\n/).find(line => /Unsupported test runtime:|\bnot ok\b|^\s*(?:npm ERR!|Error:|✖)/i.test(line)) || "");
}

function packageDependencies(version) {
	const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	return Object.fromEntries(Object.entries(pkg.devDependencies).map(([name, current]) => [
		name,
		name.startsWith("@deepseek-ai/dsh-") ? version : current,
	]));
}

function baseReport(args) {
	return {
		schemaVersion: 1,
		tag: args.tag,
		version: args.version,
		commit: args.commit,
		pluginSha: args.pluginSha,
		runUrl: args.runUrl || null,
	};
}

function prepare(args) {
	required(args, "version", "tag", "commit", "pluginSha", "scratch", "report");
	if (!/^dsh-v[0-9A-Za-z.-]+$/.test(args.tag)) throw new Error("Invalid upstream tag");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.version)) throw new Error("Invalid Harness version");
	if (!/^[a-f0-9]{40}$/i.test(args.commit) || !/^[a-f0-9]{40}$/i.test(args.pluginSha)) throw new Error("Commit and plugin SHA must be exact 40-character hashes");
	const scratch = absolute(args.scratch, "scratch");
	const reportPath = absolute(args.report, "report");
	const dependenciesDirectory = join(scratch, "dependencies");
	const home = join(scratch, "home");
	mkdirSync(dependenciesDirectory, { recursive: true });
	const dependencies = packageDependencies(args.version);
	writeFileSync(join(dependenciesDirectory, "package.json"), JSON.stringify({ private: true, dependencies }, null, 2) + "\n");
	const install = runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: dependenciesDirectory,
		env: safeEnvironment(home),
	});
	const common = { ...baseReport(args), preparedAt: new Date().toISOString(), dependencies };
	if (install.error || install.status !== 0) {
		const result = classifyInstallFailure(install.output || install.error?.message);
		writeGithubOutput(args.githubOutput, "ready", "false");
		return saveReport(reportPath, {
			...common,
			...result,
			firstFailure: firstFailure(install.output || install.error?.message),
			outputTail: outputTail(install.output || install.error?.message || ""),
		}, args.githubOutput);
	}
	const lockfile = readFileSync(join(dependenciesDirectory, "package-lock.json"));
	const dependencyDigest = sha256(lockfile);
	const runnerFiles = ["scripts/test-installed-runtime.mjs", "index.js", "package.json"];
	const runnerDigest = sha256(runnerFiles.map(file => `${file}\0${readFileSync(join(source, file))}`).join("\0"));
	const runnerSupportedVersions = extractSupportedVersions(readFileSync(join(source, "scripts/test-installed-runtime.mjs"), "utf8"));
	if (runnerSupportedVersions.length === 0) throw new Error("Could not determine the stock runner's supported Harness versions");
	const comboDigest = buildComboDigest({
		pluginSha: args.pluginSha,
		tag: args.tag,
		commit: args.commit,
		dependencyDigest,
		runnerDigest,
	});
	const plan = {
		...common,
		classification: "PREPARED",
		reason: "dependency lock resolved",
		dependencyDigest,
		runnerDigest,
		runnerSupportedVersions,
		runnerSupportsVersion: runnerSupportedVersions.includes(args.version),
		comboDigest,
		dependenciesDirectory,
		home,
	};
	const planPath = join(scratch, "plan.json");
	writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
	writeGithubOutput(args.githubOutput, "ready", "true");
	writeGithubOutput(args.githubOutput, "plan", planPath);
	writeGithubOutput(args.githubOutput, "combo_digest", comboDigest);
	writeGithubOutput(args.githubOutput, "dependency_digest", dependencyDigest);
	writeGithubOutput(args.githubOutput, "runner_digest", runnerDigest);
	return saveReport(reportPath, plan, args.githubOutput);
}

function installedVersions(dependenciesDirectory, dependencies) {
	const versions = {};
	for (const name of Object.keys(dependencies)) {
		const path = join(dependenciesDirectory, "node_modules", ...name.split("/"), "package.json");
		versions[name] = JSON.parse(readFileSync(path, "utf8")).version;
	}
	return versions;
}

function run(args) {
	required(args, "plan", "report");
	const plan = JSON.parse(readFileSync(absolute(args.plan, "plan"), "utf8"));
	const reportPath = absolute(args.report, "report");
	if (!plan.runnerSupportsVersion) {
		return saveReport(reportPath, {
			...plan,
			classification: "NOT_VERIFIED",
			reason: "runner unsupported",
			testedAt: new Date().toISOString(),
			firstFailure: "",
			outputTail: `Supported Harness versions: ${plan.runnerSupportedVersions.join(", ")}`,
		}, args.githubOutput);
	}
	const install = runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: plan.dependenciesDirectory,
		env: safeEnvironment(plan.home),
	});
	if (install.error || install.status !== 0) {
		const result = classifyInstallFailure(install.output || install.error?.message);
		return saveReport(reportPath, {
			...plan,
			...result,
			testedAt: new Date().toISOString(),
			firstFailure: firstFailure(install.output || install.error?.message),
			outputTail: outputTail(install.output || install.error?.message || ""),
		}, args.githubOutput);
	}
	const runtime = runCommand(process.execPath, [join(source, "scripts/test-installed-runtime.mjs"), "--modules", join(plan.dependenciesDirectory, "node_modules")], {
		cwd: source,
		env: safeEnvironment(plan.home),
	});
	const result = classifyRunnerResult({ status: runtime.status, output: runtime.output, error: runtime.error });
	return saveReport(reportPath, {
		...plan,
		...result,
		testedAt: new Date().toISOString(),
		installedVersions: installedVersions(plan.dependenciesDirectory, plan.dependencies),
		testExitCode: runtime.status,
		firstFailure: result.classification === "COMPATIBLE" ? "" : firstFailure(runtime.output || runtime.error?.message),
		outputTail: outputTail(runtime.output || runtime.error?.message || ""),
	}, args.githubOutput);
}

function reuse(args) {
	required(args, "cachedReport", "report");
	const previous = JSON.parse(readFileSync(absolute(args.cachedReport, "cached report"), "utf8"));
	return saveReport(absolute(args.report, "report"), {
		...previous,
		classification: "SKIPPED",
		reason: "combination already tested",
		previousClassification: previous.classification,
		previousReason: previous.reason,
		reusedAt: new Date().toISOString(),
	}, args.githubOutput);
}

function cache(args) {
	required(args, "report", "cacheDirectory");
	const report = JSON.parse(readFileSync(absolute(args.report, "report"), "utf8"));
	if (["PREPARED", "INFRA_ERROR", "SKIPPED"].includes(report.classification)) {
		console.log(`Not caching ${report.classification}`);
		return report;
	}
	const directory = absolute(args.cacheDirectory, "cache directory");
	mkdirSync(directory, { recursive: true });
	cpSync(absolute(args.report, "report"), join(directory, "report.json"));
	console.log(`Cached ${report.classification} report at ${directory}`);
	return report;
}

function findReports(directory) {
	const reports = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) reports.push(...findReports(path));
		else if (entry.name === "report.json" && statSync(path).isFile()) reports.push({ path, report: JSON.parse(readFileSync(path, "utf8")) });
	}
	return reports;
}

function aggregate(args) {
	required(args, "reportsDirectory", "output", "markdown");
	const reports = findReports(absolute(args.reportsDirectory, "reports directory"));
	const expectedCount = args.expectedCount === undefined ? reports.length : Number(args.expectedCount);
	if (!Number.isInteger(expectedCount) || expectedCount < 0) throw new Error("--expected-count must be a non-negative integer");
	const complete = reports.length === expectedCount;
	const counts = {}, effectiveCounts = {};
	for (const { report } of reports) {
		counts[report.classification] = (counts[report.classification] ?? 0) + 1;
		const effective = report.classification === "SKIPPED" ? report.previousClassification : report.classification;
		effectiveCounts[effective] = (effectiveCounts[effective] ?? 0) + 1;
	}
	const value = { capturedAt: new Date().toISOString(), expectedCount, reportCount: reports.length, complete, counts, effectiveCounts, reports: reports.map(item => ({ artifactPath: item.path, ...item.report })) };
	writeFileSync(absolute(args.output, "output"), JSON.stringify(value, null, 2) + "\n");
	const lines = [
		"# Upstream compatibility watch",
		"",
		"| Harness tag | Commit | Result | Reason |",
		"| --- | --- | --- | --- |",
		...value.reports.map(({ tag, commit, classification, previousClassification, reason }) =>
			`| \`${sanitizeReportText(tag)}\` | \`${sanitizeReportText(commit).slice(0, 12)}\` | **${sanitizeReportText(classification)}${previousClassification ? ` (${sanitizeReportText(previousClassification)})` : ""}** | ${sanitizeReportText(reason)} |`),
		"",
		...(complete ? [] : [`**INFRA_ERROR:** expected ${expectedCount} reports but received ${reports.length}.`, ""]),
		"`NOT_VERIFIED` is not an incompatibility result. It means the stock runner or published dependency set could not test that version.",
		"This report is not release or upgrade approval.",
	];
	const markdown = lines.join("\n") + "\n";
	writeFileSync(absolute(args.markdown, "markdown"), markdown);
	if (args.stepSummary) appendFileSync(absolute(args.stepSummary, "step summary"), markdown);
	writeGithubOutput(args.githubOutput, "has_incompatible", String(Boolean(counts.INCOMPATIBLE)));
	writeGithubOutput(args.githubOutput, "has_infra_error", String(Boolean(counts.INFRA_ERROR) || !complete));
	writeGithubOutput(args.githubOutput, "has_not_verified", String(Boolean(counts.NOT_VERIFIED)));
	writeGithubOutput(args.githubOutput, "report_count", String(reports.length));
	writeGithubOutput(args.githubOutput, "complete", String(complete));
	console.log(markdown);
	return value;
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "prepare") prepare(args);
else if (args.command === "run") run(args);
else if (args.command === "reuse") reuse(args);
else if (args.command === "cache") cache(args);
else if (args.command === "aggregate") aggregate(args);
else throw new Error(`Unknown command: ${args.command}`);
