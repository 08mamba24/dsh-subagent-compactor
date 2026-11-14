import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildComboDigest,
	classifyInstallFailure,
	classifyRunnerResult,
	extractSupportedVersions,
	normalizeHarnessVersion,
	renderIssueBody,
	selectUpstreamCandidates,
} from "../scripts/lib/upstream-compat-core.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

function temporary(t) {
	const path = mkdtempSync(join(tmpdir(), "dsh-upstream-watch-test-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

const releases = [
	{
		tag_name: "dsh-v0.2.2-rc.3",
		draft: false,
		prerelease: true,
		published_at: "2026-11-13T07:56:55Z",
		html_url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3",
	},
	{
		tag_name: "dsh-v0.2.2-rc.2",
		draft: true,
		prerelease: true,
		published_at: "2026-11-11T11:33:06Z",
		html_url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2",
	},
];

const tags = [
	{ name: "dsh-v0.2.2-rc.3", commit: { sha: "38a6a5c965aa99ab525161efb7cc5cf1fe62fced" } },
	{ name: "dsh-v0.2.2-rc.2", commit: { sha: "ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c" } },
	{ name: "dsh-v0.2.2-rc.1", commit: { sha: "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db" } },
	{ name: "web-v9.9.9", commit: { sha: "1111111111111111111111111111111111111111" } },
];

test("discovers prereleases, excludes drafts, and preserves exact tag commits", () => {
	const candidates = selectUpstreamCandidates({ releases, tags, limit: 3 });
	assert.deepEqual(candidates.map(({ tag, version, commit, source, prerelease }) => ({ tag, version, commit, source, prerelease })), [
		{
			tag: "dsh-v0.2.2-rc.3",
			version: "0.2.2-rc.3",
			commit: "38a6a5c965aa99ab525161efb7cc5cf1fe62fced",
			source: "release",
			prerelease: true,
		},
		{
			tag: "dsh-v0.2.2-rc.1",
			version: "0.2.2-rc.1",
			commit: "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db",
			source: "tag",
			prerelease: true,
		},
	]);
});

test("manual tag selection remains exact and rejects non-DSH tags", () => {
	assert.equal(normalizeHarnessVersion("dsh-v0.2.2-rc.3"), "0.2.2-rc.3");
	assert.equal(normalizeHarnessVersion("web-v9.9.9"), undefined);
	assert.deepEqual(selectUpstreamCandidates({ releases, tags, requestedTag: "dsh-v0.2.2-rc.1" }).map(item => item.tag), ["dsh-v0.2.2-rc.1"]);
	assert.throws(() => selectUpstreamCandidates({ releases, tags, requestedTag: "dsh-v9.9.9" }), /not found/);
});

test("dedup digest changes for every compatibility identity input", () => {
	const base = {
		pluginSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		tag: "dsh-v0.2.2-rc.3",
		commit: "38a6a5c965aa99ab525161efb7cc5cf1fe62fced",
		dependencyDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		runnerDigest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
	};
	const first = buildComboDigest(base);
	assert.match(first, /^[a-f0-9]{64}$/);
	assert.equal(first, buildComboDigest({ ...base }));
	for (const [key, value] of [
		["pluginSha", "dddddddddddddddddddddddddddddddddddddddd"],
		["tag", "dsh-v0.2.2-rc.4"],
		["commit", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
		["dependencyDigest", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
		["runnerDigest", "1111111111111111111111111111111111111111111111111111111111111111"],
	]) assert.notEqual(first, buildComboDigest({ ...base, [key]: value }), key);
});

test("recognizes both the fixed-version and supportedVersions runner contracts", () => {
	assert.deepEqual(extractSupportedVersions('const version = "0.2.2-rc.1";'), ["0.2.2-rc.1"]);
	assert.deepEqual(extractSupportedVersions('const supportedVersions = new Set(["0.2.2-rc.1", "0.2.2-rc.2"]);'), ["0.2.2-rc.1", "0.2.2-rc.2"]);
	assert.deepEqual(extractSupportedVersions("const version = process.env.VERSION;"), []);
});

test("a zero-exit runner without executed-test evidence is never COMPATIBLE", () => {
	const footer = (over = {}) => Object.entries({ tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...over })
		.map(([label, value]) => `\u2139 ${label} ${value}`).join("\n") + "\n";
	/* Exit code 0 alone proves nothing: empty output, a zero-test run, and a
	 * fully-skipped run must all stay unverified instead of passing. */
	assert.equal(classifyRunnerResult({ status: 0, output: "" }).classification, "NOT_VERIFIED");
	assert.equal(classifyRunnerResult({ status: 0, output: footer({ tests: 0, pass: 0 }) }).classification, "NOT_VERIFIED");
	assert.equal(classifyRunnerResult({ status: 0, output: footer({ pass: 0, skipped: 10 }) }).classification, "NOT_VERIFIED");
	/* All-TODO is Node's recorded "not actually finished" state: zero real
	 * passes must never certify compatibility (review 2026-11-14). */
	assert.equal(classifyRunnerResult({ status: 0, output: footer({ pass: 0, todo: 10 }) }).classification, "NOT_VERIFIED");
	/* Cancelled, contradictory counters, and an incomplete footer are not evidence either. */
	assert.equal(classifyRunnerResult({ status: 0, output: footer({ cancelled: 2 }) }).classification, "NOT_VERIFIED");
	assert.equal(classifyRunnerResult({ status: 0, output: footer({ fail: 1 }) }).classification, "NOT_VERIFIED");
	assert.equal(classifyRunnerResult({ status: 0, output: "\u2139 tests 10\n\u2139 pass 10\n\u2139 fail 0\n\u2139 skipped 0\n" }).classification, "NOT_VERIFIED");
	const real = classifyRunnerResult({ status: 0, output: footer() });
	assert.equal(real.classification, "COMPATIBLE");
	assert.deepEqual(real.testSummary, { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
	/* A failing assertion inside a TODO body is a real failure, not a pass. */
	assert.equal(classifyRunnerResult({ status: 1, output: footer({ pass: 0, fail: 10, todo: 0 }) }).classification, "INCOMPATIBLE");
	/* A module/entry load failure is an environment problem, not a product
	 * compatibility verdict. */
	assert.equal(classifyRunnerResult({ status: 1, output: "node:internal/modules/cjs/loader Error: Cannot find module 'x'" }).classification, "NOT_VERIFIED");
	assert.equal(classifyRunnerResult({ status: 1, output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module" }).classification, "NOT_VERIFIED");
});

test("classifies unavailable packages, infrastructure failures, unsupported runners, and compatibility failures distinctly", () => {
	assert.deepEqual(classifyInstallFailure("npm ERR! code ETARGET\nnpm ERR! notarget No matching version found"), {
		classification: "NOT_VERIFIED",
		reason: "dependency version unavailable",
	});
	assert.deepEqual(classifyInstallFailure("npm ERR! code ECONNRESET"), {
		classification: "INFRA_ERROR",
		reason: "dependency resolution failed",
	});
	assert.deepEqual(classifyRunnerResult({ status: 1, output: "Unsupported test runtime: 0.2.2-rc.3" }), {
		classification: "NOT_VERIFIED",
		reason: "runner unsupported",
	});
	assert.deepEqual(classifyRunnerResult({ status: 1, output: "not ok 3 - direct child compaction" }), {
		classification: "INCOMPATIBLE",
		reason: "stock compatibility suite failed",
	});
	/* Exit code 0 without a complete spec footer is not evidence: the same
	 * call now stays unverified instead of passing (2026-11-13 review). */
	assert.deepEqual(classifyRunnerResult({ status: 0, output: "tests 92\npass 92\nfail 0" }), {
		classification: "NOT_VERIFIED",
		reason: "runner produced no test evidence",
	});
	assert.deepEqual(classifyRunnerResult({ status: 0, output: "\u2139 tests 92\n\u2139 pass 92\n\u2139 fail 0\n\u2139 cancelled 0\n\u2139 skipped 0\n\u2139 todo 0\n" }), {
		classification: "COMPATIBLE",
		reason: "stock compatibility suite passed",
		testSummary: { tests: 92, pass: 92, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
	});
});

test("issue body records provenance, classification, first failure, and report link without executable HTML", () => {
	const body = renderIssueBody({
		classification: "INCOMPATIBLE",
		reason: "stock compatibility suite failed",
		tag: "dsh-v0.2.2-rc.3",
		version: "0.2.2-rc.3",
		commit: "38a6a5c965aa99ab525161efb7cc5cf1fe62fced",
		pluginSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		dependencyDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		firstFailure: "<script>alert(1)</script>\nsecond line",
		runUrl: "https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/123",
		fingerprint: "c".repeat(64),
	});
	assert.match(body, /INCOMPATIBLE/);
	assert.match(body, /38a6a5c965aa99ab525161efb7cc5cf1fe62fced/);
	assert.match(body, /actions\/runs\/123/);
	assert.doesNotMatch(body, /<script>/);
	assert.match(body, /alert\(1\)/);
	assert.match(body, /upstream-compat-fingerprint:c{64}/);
});

test("discovery CLI emits a GitHub matrix from fixtures without network access", t => {
	const directory = temporary(t);
	const releasesPath = join(directory, "releases.json"), tagsPath = join(directory, "tags.json");
	const output = join(directory, "discovery.json"), githubOutput = join(directory, "github-output.txt");
	writeFileSync(releasesPath, JSON.stringify(releases));
	writeFileSync(tagsPath, JSON.stringify(tags));
	const result = spawnSync(process.execPath, [
		join(repository, "scripts/discover-upstream.mjs"),
		"--releases-file", releasesPath,
		"--tags-file", tagsPath,
		"--limit", "3",
		"--output", output,
		"--github-output", githubOutput,
	], { encoding: "utf8", cwd: repository });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).candidates.map(item => item.tag), ["dsh-v0.2.2-rc.3", "dsh-v0.2.2-rc.1"]);
	const values = Object.fromEntries(readFileSync(githubOutput, "utf8").trim().split("\n").map(line => {
		const at = line.indexOf("=");
		return [line.slice(0, at), line.slice(at + 1)];
	}));
	assert.equal(values.has_candidates, "true");
	assert.deepEqual(JSON.parse(values.matrix).include.map(item => item.commit), [
		"38a6a5c965aa99ab525161efb7cc5cf1fe62fced",
		"66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db",
	]);
});

test("aggregate CLI preserves NOT_VERIFIED as a distinct non-compatible result", t => {
	const directory = temporary(t), reports = join(directory, "reports");
	for (const [name, classification, reason] of [
		["rc1", "COMPATIBLE", "stock compatibility suite passed"],
		["rc3", "NOT_VERIFIED", "runner unsupported"],
		["rc4", "SKIPPED", "combination already tested"],
	]) {
		const target = join(reports, name, "report.json");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify({ tag: `dsh-v0.2.2-${name}`, commit: "a".repeat(40), classification, reason, ...(classification === "SKIPPED" ? { previousClassification: "INCOMPATIBLE" } : {}) }));
	}
	const output = join(directory, "summary.json"), markdown = join(directory, "summary.md"), githubOutput = join(directory, "github-output.txt");
	const result = spawnSync(process.execPath, [
		join(repository, "scripts/upstream-compat.mjs"), "aggregate",
		"--reports-directory", reports,
		"--output", output,
		"--markdown", markdown,
		"--github-output", githubOutput,
	], { encoding: "utf8", cwd: repository });
	assert.equal(result.status, 0, result.stderr);
	const aggregate = JSON.parse(readFileSync(output, "utf8"));
	assert.deepEqual(aggregate.counts, { COMPATIBLE: 1, NOT_VERIFIED: 1, SKIPPED: 1 });
	assert.deepEqual(aggregate.effectiveCounts, { COMPATIBLE: 1, NOT_VERIFIED: 1, INCOMPATIBLE: 1 });
	assert.match(readFileSync(markdown, "utf8"), /NOT_VERIFIED.*runner unsupported/);
	assert.match(readFileSync(githubOutput, "utf8"), /has_not_verified=true/);
	/* The gate flag reads the EFFECTIVE verdict: this run skipped a target
	 * whose cached verdict was INCOMPATIBLE, so the gate must stay red. */
	assert.match(readFileSync(githubOutput, "utf8"), /has_incompatible=true/);
	assert.match(readFileSync(githubOutput, "utf8"), /skipped_count=1/);
});

test("prepare CLI records the runner support decision before any runtime execution", t => {
	const directory = temporary(t), bin = join(directory, "bin");
	mkdirSync(bin);
	const fakeNpm = join(bin, "npm");
	writeFileSync(fakeNpm, "#!/bin/sh\nprintf '%s\\n' '{\"lockfileVersion\":3,\"packages\":{}}' > package-lock.json\n");
	chmodSync(fakeNpm, 0o755);
	for (const [version, expected] of [["0.2.2-rc.1", true], ["0.2.2-rc.3", false]]) {
		const scratch = join(directory, version), report = join(scratch, "report.json");
		const result = spawnSync(process.execPath, [
			join(repository, "scripts/upstream-compat.mjs"), "prepare",
			"--version", version,
			"--tag", `dsh-v${version}`,
			"--commit", "a".repeat(40),
			"--plugin-sha", "b".repeat(40),
			"--scratch", scratch,
			"--report", report,
		], { encoding: "utf8", cwd: repository, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
		assert.equal(result.status, 0, result.stderr);
		const plan = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8"));
		assert.deepEqual(plan.runnerSupportedVersions, ["0.2.2-rc.1"]);
		assert.equal(plan.runnerSupportsVersion, expected);
	}
});

test("workflow keeps execution read-only and isolates issue write permission", () => {
	const workflow = readFileSync(join(repository, ".github/workflows/upstream-compat.yml"), "utf8");
	assert.match(workflow, /cron: "23 \* \* \* \*"/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.doesNotMatch(workflow, /^\s+release:/m);
	assert.match(workflow, /permissions:\n  contents: read/);
	assert.match(workflow, /notify:[\s\S]*?permissions:\n      contents: read\n      issues: write/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /dsh-upstream-compat-v2-\$\{\{ steps.prepare.outputs.combo_digest \}\}-\$\{\{ steps.cache.outputs.result_digest \}\}/, "cache keys embed the result digest so a changed verdict gets a fresh entry");
	assert.match(workflow, /restore-keys: dsh-upstream-compat-v2-/, "restore uses the prefix and lets inspect validate the entry");
	assert.match(workflow, /upstream-compat.mjs inspect/, "a restored verdict is validated against the exact combination before skipping");
	assert.match(workflow, /--expected-targets/, "aggregate validates reports against the discovered targets");
	/* Saving must follow what this run executed (run.outcome), never the
	 * pre-run skip decision: a forced recheck over a valid cache still saves
	 * its fresh verdict. */
	const saveBlocks = workflow.split("- name: Prepare a reusable result marker")[1] ?? "";
	assert.match(saveBlocks, /steps\.run\.outcome == 'success'/, "the cache step saves only what this run actually executed");
	assert.doesNotMatch(saveBlocks, /inspect\.outputs\.skip != 'true'/, "a pre-run skip decision must never block saving a forced recheck's result");
	assert.match(saveBlocks, /--plugin-sha/);
});

/** A gh stand-in that records every call and replays a configurable issue list. */
function fakeGh(t, directory, issues) {
	const bin = join(directory, "bin"), record = join(directory, "gh-calls.log");
	mkdirSync(bin, { recursive: true });
	/* The issue list travels through the environment so no shell quoting
	 * can corrupt the JSON the real gh would print. */
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + record + "'\nif [ \"$1 $2\" = \"issue list\" ]; then printf '%s' \"$ISSUES_JSON\"; exit 0; fi\nif [ \"$1 $2\" = \"issue create\" ]; then echo \"https://example.invalid/issues/1\"; exit 0; fi\nexit 0\n");
	chmodSync(join(bin, "gh"), 0o755);
	const withIssues = { ...process.env, ISSUES_JSON: JSON.stringify(issues), PATH: `${bin}:${process.env.PATH}` };
	return { record, env: withIssues };
}

function writeReport(reports, name, report) {
	const target = join(reports, name, "report.json");
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(report));
}

const targetFixture = [{ tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40) }];

function runAggregate(t, reports, expectedTargets, pluginSha) {
	const directory = temporary(t);
	const output = join(directory, "summary.json"), markdown = join(directory, "summary.md"), githubOutput = join(directory, "github-output.txt");
	const args = [
		join(repository, "scripts/upstream-compat.mjs"), "aggregate",
		"--reports-directory", reports,
		"--output", output,
		"--markdown", markdown,
		"--github-output", githubOutput,
		"--expected-count", String(expectedTargets.length),
		"--expected-targets", JSON.stringify(expectedTargets),
		...(pluginSha !== undefined ? ["--plugin-sha", pluginSha] : []),
	];
	const result = spawnSync(process.execPath, args, { encoding: "utf8", cwd: repository });
	return { result, output, markdown, githubOutput };
}

test("aggregate refuses to call a PREPARED-only run complete", t => {
	const directory = temporary(t), reports = join(directory, "reports");
	writeReport(reports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "PREPARED", reason: "dependency lock resolved" });
	const { result, output, githubOutput } = runAggregate(t, reports, targetFixture);
	assert.equal(result.status, 0, result.stderr);
	const aggregate = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(aggregate.complete, false, "an intermediate PREPARED report must never count as a complete result");
	assert.match(readFileSync(githubOutput, "utf8"), /has_infra_error=true/);
	assert.equal(aggregate.effectiveCounts.INFRA_ERROR, 1);
});

test("aggregate rejects missing, duplicate, and unknown-classification reports", t => {
	const missing = temporary(t);
	mkdirSync(join(missing, "empty"), { recursive: true });
	const { result: missingResult, output: missingOutput } = runAggregate(t, join(missing, "empty"), targetFixture);
	assert.equal(missingResult.status, 0, missingResult.stderr);
	assert.equal(JSON.parse(readFileSync(missingOutput, "utf8")).complete, false);

	const duplicate = temporary(t), reports = join(duplicate, "reports");
	const report = { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "COMPATIBLE", reason: "stock compatibility suite passed" };
	writeReport(reports, "a", report);
	writeReport(reports, "b", report);
	const { result: duplicateResult, output: duplicateOutput } = runAggregate(t, reports, targetFixture);
	assert.equal(duplicateResult.status, 0, duplicateResult.stderr);
	assert.equal(JSON.parse(readFileSync(duplicateOutput, "utf8")).complete, false, "two reports for one target must not satisfy the expected count");

	const unknown = temporary(t), unknownReports = join(unknown, "reports");
	writeReport(unknownReports, "a", { ...report, classification: "SOMETHING_ELSE", reason: "?" });
	const { result: unknownResult, output: unknownOutput } = runAggregate(t, unknownReports, targetFixture);
	assert.equal(unknownResult.status, 0, unknownResult.stderr);
	assert.equal(JSON.parse(readFileSync(unknownOutput, "utf8")).complete, false, "an unknown classification must fail validation");
});

test("aggregate rejects a COMPATIBLE report without executed-test evidence or with a foreign plugin SHA", t => {
	const directory = temporary(t), reports = join(directory, "reports");
	writeReport(reports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "COMPATIBLE", reason: "stock compatibility suite passed" });
	const evidenceless = runAggregate(t, reports, targetFixture, "b".repeat(40));
	assert.equal(evidenceless.result.status, 0, evidenceless.result.stderr);
	assert.equal(JSON.parse(readFileSync(evidenceless.output, "utf8")).complete, false, "a COMPATIBLE verdict without parsed test evidence must not validate");
	assert.match(readFileSync(evidenceless.githubOutput, "utf8"), /has_infra_error=true/);

	const foreign = temporary(t), foreignReports = join(foreign, "reports");
	writeReport(foreignReports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "c".repeat(40), classification: "COMPATIBLE", reason: "stock compatibility suite passed", testExitCode: 0, testSummary: { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 } });
	const foreignRun = runAggregate(t, foreignReports, targetFixture, "b".repeat(40));
	assert.equal(foreignRun.result.status, 0, foreignRun.result.stderr);
	assert.equal(JSON.parse(readFileSync(foreignRun.output, "utf8")).complete, false, "a report from a different plugin SHA must not validate against this run");

	const sound = temporary(t), soundReports = join(sound, "reports");
	writeReport(soundReports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "COMPATIBLE", reason: "stock compatibility suite passed", testExitCode: 0, testSummary: { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 } });
	const soundRun = runAggregate(t, soundReports, targetFixture, "b".repeat(40));
	assert.equal(soundRun.result.status, 0, soundRun.result.stderr);
	assert.equal(JSON.parse(readFileSync(soundRun.output, "utf8")).complete, true, "evidence-backed COMPATIBLE with the exact plugin SHA validates");
});

test("aggregate and inspect apply the same evidence rule to a TODO-only or cancelled suite", t => {
	/* A cached/forged COMPATIBLE whose footer records zero real passes
	 * (all TODO) must be rejected by aggregation AND by cache inspection —
	 * no layer may accept what another rejects. */
	const todoDirectory = temporary(t), todoReports = join(todoDirectory, "reports");
	writeReport(todoReports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "COMPATIBLE", reason: "stock compatibility suite passed", testExitCode: 0, testSummary: { tests: 10, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 10 } });
	const todoRun = runAggregate(t, todoReports, targetFixture, "b".repeat(40));
	assert.equal(todoRun.result.status, 0, todoRun.result.stderr);
	assert.equal(JSON.parse(readFileSync(todoRun.output, "utf8")).complete, false, "a TODO-only suite never validates as COMPATIBLE");

	const cacheDirectory = join(todoDirectory, "cache");
	mkdirSync(cacheDirectory, { recursive: true });
	writeFileSync(join(cacheDirectory, "report.json"), JSON.stringify({ comboDigest: "d".repeat(64), classification: "COMPATIBLE", testExitCode: 0, testSummary: { tests: 10, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 10 } }));
	const githubOutput = join(todoDirectory, "inspect-out.txt");
	const inspectResult = spawnSync(process.execPath, [join(repository, "scripts/upstream-compat.mjs"), "inspect",
		"--cache-directory", cacheDirectory, "--combo-digest", "d".repeat(64), "--github-output", githubOutput,
	], { encoding: "utf8", cwd: repository });
	assert.equal(inspectResult.status, 0, inspectResult.stderr);
	assert.match(readFileSync(githubOutput, "utf8"), /skip=false/, "cache inspection reuses the same evidence rule and refuses to skip on a TODO-only cached verdict");

	writeFileSync(join(cacheDirectory, "report.json"), JSON.stringify({ comboDigest: "d".repeat(64), classification: "COMPATIBLE", testExitCode: 0, testSummary: { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 } }));
	const soundOutput = join(todoDirectory, "inspect-sound.txt");
	const soundInspect = spawnSync(process.execPath, [join(repository, "scripts/upstream-compat.mjs"), "inspect",
		"--cache-directory", cacheDirectory, "--combo-digest", "d".repeat(64), "--github-output", soundOutput,
	], { encoding: "utf8", cwd: repository });
	assert.equal(soundInspect.status, 0, soundInspect.stderr);
	assert.match(readFileSync(soundOutput, "utf8"), /skip=true/);
});

test("aggregate gate flags read the effective verdict, not this run's skip bookkeeping", t => {
	const directory = temporary(t), reports = join(directory, "reports");
	writeReport(reports, "rc1", { tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), classification: "SKIPPED", reason: "combination already tested", previousClassification: "INCOMPATIBLE", previousReason: "stock compatibility suite failed" });
	const { result, githubOutput } = runAggregate(t, reports, targetFixture);
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(githubOutput, "utf8"), /has_incompatible=true/, "a cached INCOMPATIBLE verdict must keep the gate red");
	assert.match(readFileSync(githubOutput, "utf8"), /skipped_count=1/);
});

test("notify delivers a cached verdict that was never delivered before", t => {
	const directory = temporary(t);
	const gh = fakeGh(t, directory, []);
	const record = gh.record;
	const aggregatePath = join(directory, "aggregate.json");
	writeFileSync(aggregatePath, JSON.stringify({ reports: [
		{ tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), dependencyDigest: "c".repeat(64), classification: "SKIPPED", reason: "combination already tested", previousClassification: "INCOMPATIBLE", previousReason: "stock compatibility suite failed", firstFailure: "not ok suite" },
	] }));
	const result = spawnSync(process.execPath, [join(repository, "scripts/notify-upstream-compat.mjs"),
		"--aggregate", aggregatePath, "--repository", "example/invalid", "--run-url", "https://example.invalid/runs/1", "--output", join(directory, "notification.json"),
	], { encoding: "utf8", cwd: repository, env: gh.env });
	assert.equal(result.status, 0, result.stderr);
	const actions = JSON.parse(readFileSync(join(directory, "notification.json"), "utf8")).actions;
	assert.deepEqual(actions.map(action => action.action), ["created"], "a never-delivered cached INCOMPATIBLE verdict must create its issue");
	assert.match(readFileSync(record, "utf8"), /issue create/);
});

test("notify stays quiet for an already-delivered identical cached verdict", t => {
	const directory = temporary(t);
	const existing = [{ number: 7, title: "[upstream-compat] dsh-v0.2.2-rc1", state: "OPEN", body: "old body without fingerprint" }];
	const gh = fakeGh(t, directory, existing);
	const record = gh.record;
	const aggregatePath = join(directory, "aggregate.json");
	writeFileSync(aggregatePath, JSON.stringify({ reports: [
		{ tag: "dsh-v0.2.2-rc1", version: "0.2.2-rc1", commit: "a".repeat(40), pluginSha: "b".repeat(40), dependencyDigest: "c".repeat(64), classification: "SKIPPED", reason: "combination already tested", previousClassification: "COMPATIBLE", previousReason: "stock compatibility suite passed" },
	] }));
	const result = spawnSync(process.execPath, [join(repository, "scripts/notify-upstream-compat.mjs"),
		"--aggregate", aggregatePath, "--repository", "example/invalid", "--run-url", "https://example.invalid/runs/1", "--output", join(directory, "notification.json"),
	], { encoding: "utf8", cwd: repository, env: gh.env });
	assert.equal(result.status, 0, result.stderr);
	const actions = JSON.parse(readFileSync(join(directory, "notification.json"), "utf8")).actions;
	assert.deepEqual(actions.map(action => action.action), ["updated"], "an existing issue without the current fingerprint is updated, not skipped");
	assert.match(readFileSync(record, "utf8"), /issue edit/);
});

test("cache emits a result digest so a changed verdict gets a fresh cache key", t => {
	const directory = temporary(t);
	const digests = [];
	for (const classification of ["INCOMPATIBLE", "COMPATIBLE"]) {
		const reportPath = join(directory, `${classification}.json`), cacheDirectory = join(directory, `cache-${classification}`);
		writeFileSync(reportPath, JSON.stringify({ tag: "dsh-v0.2.2-rc1", classification, reason: "r" }));
		const githubOutput = join(directory, `out-${classification}.txt`);
		const result = spawnSync(process.execPath, [join(repository, "scripts/upstream-compat.mjs"), "cache",
			"--report", reportPath, "--cache-directory", cacheDirectory, "--github-output", githubOutput,
		], { encoding: "utf8", cwd: repository });
		assert.equal(result.status, 0, result.stderr);
		digests.push(/result_digest=(\S+)/.exec(readFileSync(githubOutput, "utf8"))?.[1]);
	}
	assert.notEqual(digests[0], digests[1], "a changed verdict must change the cache key");
	assert.ok(digests.every(digest => /^\S+$/.test(digest)));
});
