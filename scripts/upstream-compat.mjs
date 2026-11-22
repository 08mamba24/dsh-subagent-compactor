#!/usr/bin/env node
import { spawn } from "node:child_process";
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
	evaluateTestEvidence,
	extractSupportedVersions,
	sanitizeReportText,
	sha256,
	TERMINAL_CLASSIFICATIONS,
} from "./lib/upstream-compat-core.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!command) throw new Error("Expected a command: prepare, run, reuse, cache, inspect, or aggregate");
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

function commandTimeout(args, maximum) {
	const value = args.timeoutMs === undefined ? maximum : Number(args.timeoutMs);
	if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`--timeout-ms must be an integer from 1 to ${maximum}`);
	return value;
}

function runCommand(command, args, { timeoutMs, ...options }) {
	return new Promise(resolve => {
		const child = spawn(command, args, { ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let bytes = 0, error;
		const stop = failure => {
			if (error) return;
			error = failure;
			const diagnostic = Buffer.from(`\nError: ${failure.message}\n`);
			chunks.push(diagnostic);
			process.stderr.write(diagnostic);
			if (!child.pid) return;
			// Stop the test runner and its workers, not just the wrapper holding their pipes.
			try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); }
			catch (killError) { if (killError.code !== "ESRCH") child.kill("SIGKILL"); }
		};
		const collect = (chunk, stream) => {
			stream.write(chunk);
			bytes += chunk.length;
			if (bytes > 32 * 1024 * 1024) stop(Object.assign(new Error(`${command} exceeded the output limit`), { code: "ENOBUFS" }));
			else chunks.push(chunk);
		};
		child.stdout.on("data", chunk => collect(chunk, process.stdout));
		child.stderr.on("data", chunk => collect(chunk, process.stderr));
		child.on("error", failure => { error ??= failure; });
		const timer = setTimeout(() => stop(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs);
		const interrupted = () => stop(Object.assign(new Error(`${command} was interrupted`), { code: "EINTR" }));
		process.on("SIGTERM", interrupted);
		process.on("SIGINT", interrupted);
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			process.off("SIGTERM", interrupted);
			process.off("SIGINT", interrupted);
			resolve({ status, signal, error, output: Buffer.concat(chunks).toString("utf8") });
		});
	});
}

function outputTail(output, limit = 12_000) {
	return output.replace(/\u001b\[[0-9;]*m/g, "").slice(-limit);
}

function firstFailure(output) {
	const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
	return sanitizeReportText(clean.split(/\r?\n/).find(line => /Unsupported test runtime:|\bnot ok\b|^\s*(?:npm ERR!|Error(?: \[[^\]\r\n]+\])?:|✖)/i.test(line)) || "");
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

async function prepare(args) {
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
	const install = await runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: dependenciesDirectory,
		env: safeEnvironment(home),
		timeoutMs: commandTimeout(args, 8 * 60_000),
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

async function run(args) {
	required(args, "plan", "report");
	const plan = JSON.parse(readFileSync(absolute(args.plan, "plan"), "utf8"));
	const reportPath = absolute(args.report, "report");
	const install = await runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: plan.dependenciesDirectory,
		env: safeEnvironment(plan.home),
		timeoutMs: commandTimeout(args, 10 * 60_000),
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
	const runtime = await runCommand(process.execPath, [join(source, "scripts/test-installed-runtime.mjs"), "--modules", join(plan.dependenciesDirectory, "node_modules"), "--candidate-version", plan.version], {
		cwd: source,
		env: safeEnvironment(plan.home),
		timeoutMs: commandTimeout(args, 10 * 60_000),
	});
	const result = classifyRunnerResult({ status: runtime.status, output: runtime.output, error: runtime.error });
	return saveReport(reportPath, {
		...plan,
		...result,
		candidateRuntime: !plan.runnerSupportsVersion,
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
	const reportPath = absolute(args.report, "report");
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	if (["PREPARED", "INFRA_ERROR", "SKIPPED"].includes(report.classification)) {
		console.log(`Not caching ${report.classification}`);
		return report;
	}
	const directory = absolute(args.cacheDirectory, "cache directory");
	mkdirSync(directory, { recursive: true });
	cpSync(reportPath, join(directory, "report.json"));
	/* The save key embeds this digest: a changed verdict changes the key, so
	 * the immutable cache gains a fresh entry and later restores pick the new
	 * verdict instead of the old one. */
	const resultDigest = sha256(readFileSync(reportPath));
	writeGithubOutput(args.githubOutput, "result_digest", resultDigest.slice(0, 16));
	console.log(`Cached ${report.classification} report at ${directory} (result digest ${resultDigest.slice(0, 16)})`);
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
	const terminal = new Set(TERMINAL_CLASSIFICATIONS);
	/* An intermediate (PREPARED), unknown, or malformed classification is an
	 * infrastructure failure of the run that produced it, never a valid
	 * verdict; SKIPPED borrows its recorded previous terminal state. */
	const effectiveOf = (report) => {
		if (report.classification === "SKIPPED" && terminal.has(report.previousClassification)) return report.previousClassification;
		return terminal.has(report.classification) ? report.classification : "INFRA_ERROR";
	};
	const expectedTargets = args.expectedTargets === undefined ? null : JSON.parse(args.expectedTargets);
	if (expectedTargets !== null && !Array.isArray(expectedTargets)) throw new Error("--expected-targets must be a JSON array");
	if (args.pluginSha !== undefined && !/^[a-f0-9]{40}$/i.test(args.pluginSha)) throw new Error("--plugin-sha must be an exact 40-character hash");
	const reportsByTag = new Map();
	for (const { report } of reports) {
		if (typeof report?.tag === "string") reportsByTag.set(report.tag, [...(reportsByTag.get(report.tag) ?? []), report]);
	}
	const problems = [];
	if (expectedTargets !== null) {
		for (const target of expectedTargets) {
			const found = reportsByTag.get(target.tag) ?? [];
			if (found.length === 0) problems.push({ tag: target.tag, problem: "missing-report" });
			else if (found.length > 1) problems.push({ tag: target.tag, problem: "duplicate-report", count: found.length });
			else {
				const report = found[0];
				if (report.version !== target.version || report.commit !== target.commit) problems.push({ tag: target.tag, problem: "target-mismatch" });
				else if (!/^[a-f0-9]{40}$/i.test(String(report.pluginSha ?? ""))) problems.push({ tag: target.tag, problem: "missing-plugin-sha" });
			}
		}
		for (const tag of reportsByTag.keys()) {
			if (!expectedTargets.some(target => target.tag === tag)) problems.push({ tag, problem: "unexpected-report" });
		}
	}
	/* A COMPATIBLE verdict (this run or cached) must carry executed-test
	 * evidence under the same shared rule the classifier and the cache
	 * inspector use — see evaluateTestEvidence in the core module. */
	const hasEvidence = (report) => report.testExitCode === 0 && evaluateTestEvidence(report.testSummary).ok;
	for (const { report } of reports) {
		if (!terminal.has(report.classification) && !(report.classification === "SKIPPED" && terminal.has(report.previousClassification))) {
			problems.push({ tag: report.tag, problem: "invalid-classification", classification: report.classification });
		}
		if (args.pluginSha !== undefined && report.pluginSha !== args.pluginSha) {
			problems.push({ tag: report.tag, problem: "plugin-sha-mismatch" });
		}
		else if (args.pluginSha === undefined && !/^[a-f0-9]{40}$/i.test(String(report.pluginSha ?? ""))) {
			problems.push({ tag: report.tag, problem: "missing-plugin-sha" });
		}
		if (effectiveOf(report) === "COMPATIBLE" && !hasEvidence(report)) {
			problems.push({ tag: report.tag, problem: "missing-test-evidence" });
		}
	}
	const complete = reports.length === expectedCount && problems.length === 0;
	const counts = {}, effectiveCounts = {};
	for (const { report } of reports) {
		counts[report.classification] = (counts[report.classification] ?? 0) + 1;
		const effective = effectiveOf(report);
		effectiveCounts[effective] = (effectiveCounts[effective] ?? 0) + 1;
	}
	// An unfinished or missing report still owes an alert for the discovered target.
	// Keep raw evidence and the failed gate; never forward an unvalidated healthy verdict.
	const notificationReports = expectedTargets === null ? reports.map(({ report }) => report) : expectedTargets.map(target => {
		const faults = problems.filter(problem => problem.tag === target.tag || !expectedTargets.some(expected => expected.tag === problem.tag));
		if (faults.length === 0) return reportsByTag.get(target.tag)[0];
		return {
			tag: target.tag, version: target.version, commit: target.commit,
			pluginSha: args.pluginSha ?? target.pluginSha ?? "",
			classification: "INFRA_ERROR", reason: "compatibility report incomplete or invalid",
			firstFailure: faults.map(({ problem }) => problem).join(", "),
		};
	});
	const value = { capturedAt: new Date().toISOString(), expectedCount, reportCount: reports.length, complete, ...(problems.length > 0 ? { problems } : {}), counts, effectiveCounts, reports: reports.map(item => ({ artifactPath: item.path, ...item.report })), notificationReports };
	writeFileSync(absolute(args.output, "output"), JSON.stringify(value, null, 2) + "\n");
	const lines = [
		"# Upstream compatibility watch",
		"",
		"| Harness tag | Commit | Result | Reason |",
		"| --- | --- | --- | --- |",
		...value.reports.map(({ tag, commit, classification, previousClassification, reason }) =>
			`| \`${sanitizeReportText(tag)}\` | \`${sanitizeReportText(commit).slice(0, 12)}\` | **${sanitizeReportText(classification)}${previousClassification ? ` (${sanitizeReportText(previousClassification)})` : ""}** | ${sanitizeReportText(reason)} |`),
		"",
		...(complete ? [] : [
			`**INFRA_ERROR:** expected ${expectedCount} valid reports but received ${reports.length}${problems.length > 0 ? ` with ${problems.length} validation problem(s): ${problems.map(problem => `${problem.tag ?? "?"}:${problem.problem}`).join(", ")}` : ""}.`,
			"",
		]),
		"`NOT_VERIFIED` is not an incompatibility result. It means the stock runner or published dependency set could not test that version.",
		"This report is not release or upgrade approval.",
	];
	const markdown = lines.join("\n") + "\n";
	writeFileSync(absolute(args.markdown, "markdown"), markdown);
	if (args.stepSummary) appendFileSync(absolute(args.stepSummary, "step summary"), markdown);
	/* Gate flags read the EFFECTIVE verdict: a cached (SKIPPED) result keeps
	 * the verdict it recorded, and this run's skip bookkeeping travels only
	 * through skipped_count. */
	writeGithubOutput(args.githubOutput, "has_incompatible", String(Boolean(effectiveCounts.INCOMPATIBLE)));
	writeGithubOutput(args.githubOutput, "has_infra_error", String(Boolean(effectiveCounts.INFRA_ERROR) || !complete));
	writeGithubOutput(args.githubOutput, "has_not_verified", String(Boolean(effectiveCounts.NOT_VERIFIED)));
	writeGithubOutput(args.githubOutput, "skipped_count", String(counts.SKIPPED ?? 0));
	writeGithubOutput(args.githubOutput, "report_count", String(reports.length));
	writeGithubOutput(args.githubOutput, "complete", String(complete));
	console.log(markdown);
	return value;
}

/**
 * Validate a restored cache entry against the combination about to run: the
 * cached report must belong to this exact comboDigest and carry a terminal
 * classification. Only then may the run skip re-testing; a changed verdict or
 * a stale entry forces a fresh run, whose save key embeds the new result
 * digest so GitHub's immutable cache grows a fresh entry instead of serving
 * the old verdict forever.
 */
function inspect(args) {
	required(args, "cacheDirectory", "comboDigest");
	const reportPath = join(absolute(args.cacheDirectory, "cache directory"), "report.json");
	if (!existsSync(reportPath)) {
		writeGithubOutput(args.githubOutput, "skip", "false");
		return;
	}
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	const terminal = new Set(TERMINAL_CLASSIFICATIONS);
	/* Cache inspection reuses the shared evidence rule: a cached COMPATIBLE
	 * without executed-test evidence forces a re-run instead of a skip. */
	const evidenceOk = (report.classification === "COMPATIBLE" || (report.classification === "SKIPPED" && report.previousClassification === "COMPATIBLE"))
		? report.testExitCode === 0 && evaluateTestEvidence(report.testSummary).ok
		: true;
	const valid = report.comboDigest === args.comboDigest
		&& (terminal.has(report.classification) || (report.classification === "SKIPPED" && terminal.has(report.previousClassification)))
		&& evidenceOk;
	writeGithubOutput(args.githubOutput, "skip", String(valid));
	if (valid) writeGithubOutput(args.githubOutput, "cachedReport", reportPath);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "prepare") await prepare(args);
else if (args.command === "run") await run(args);
else if (args.command === "reuse") reuse(args);
else if (args.command === "cache") cache(args);
else if (args.command === "inspect") inspect(args);
else if (args.command === "aggregate") aggregate(args);
else throw new Error(`Unknown command: ${args.command}`);
