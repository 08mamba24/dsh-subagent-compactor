import { createHash } from "node:crypto";

const DSH_TAG = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Classifications a finished report must carry; PREPARED is intermediate, SKIPPED borrows its previous terminal state. */
export const TERMINAL_CLASSIFICATIONS = ["COMPATIBLE", "INCOMPATIBLE", "NOT_VERIFIED", "INFRA_ERROR"];

export function normalizeHarnessVersion(tag) {
	if (typeof tag !== "string") return undefined;
	return DSH_TAG.exec(tag)?.[1];
}

export function selectUpstreamCandidates({ releases, tags, limit = 3, requestedTag } = {}) {
	if (!Array.isArray(releases) || !Array.isArray(tags)) throw new TypeError("releases and tags must be arrays");
	if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
	const releaseByTag = new Map();
	const draftTags = new Set();
	for (const release of releases) {
		if (!release || typeof release.tag_name !== "string") continue;
		if (release.draft) draftTags.add(release.tag_name);
		else releaseByTag.set(release.tag_name, release);
	}

	const candidates = [];
	for (const tagRecord of tags) {
		const tag = tagRecord?.name;
		const version = normalizeHarnessVersion(tag);
		if (!version || draftTags.has(tag)) continue;
		if (requestedTag && tag !== requestedTag) continue;
		const commit = tagRecord?.commit?.sha;
		if (typeof commit !== "string" || !/^[a-f0-9]{40}$/i.test(commit)) continue;
		const release = releaseByTag.get(tag);
		candidates.push({
			tag,
			version,
			commit: commit.toLowerCase(),
			source: release ? "release" : "tag",
			prerelease: release ? Boolean(release.prerelease) : version.includes("-"),
			publishedAt: release?.published_at ?? null,
			url: release?.html_url ?? `https://github.com/deepseek-ai/deepseek-harness/releases/tag/${encodeURIComponent(tag)}`,
		});
		if (!requestedTag && candidates.length >= limit) break;
	}
	if (requestedTag && candidates.length === 0) throw new Error(`Requested upstream tag not found or not testable: ${requestedTag}`);
	return candidates;
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function buildComboDigest({ pluginSha, tag, commit, dependencyDigest, runnerDigest }) {
	for (const [name, value] of Object.entries({ pluginSha, tag, commit, dependencyDigest, runnerDigest })) {
		if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
	}
	return sha256(JSON.stringify({ pluginSha, tag, commit, dependencyDigest, runnerDigest }));
}

export function extractSupportedVersions(source) {
	const text = String(source ?? "");
	const versions = [];
	const fixed = text.match(/\bconst\s+version\s*=\s*["']([^"']+)["']/)?.[1];
	if (fixed) versions.push(fixed);
	const setBody = text.match(/\bconst\s+supportedVersions\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/)?.[1];
	if (setBody) {
		for (const match of setBody.matchAll(/["']([^"']+)["']/g)) versions.push(match[1]);
	}
	return [...new Set(versions)].filter(version => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version));
}

export function classifyInstallFailure(output = "") {
	if (/\b(?:E404|ETARGET)\b|\bnotarget\b|No matching version found|is not in this registry/i.test(output)) {
		return { classification: "NOT_VERIFIED", reason: "dependency version unavailable" };
	}
	return { classification: "INFRA_ERROR", reason: "dependency resolution failed" };
}

/**
 * Parse a complete node --test spec footer. Anything less than all six
 * counters is not evidence that a suite ran.
 */
export function parseTestSummary(output = "") {
	const summary = {};
	for (const label of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
		const value = new RegExp(`^\\u2139\\s+${label}\\s+(\\d+)\\s*$`, "m").exec(output)?.[1];
		if (value === undefined) return undefined;
		summary[label] = Number(value);
	}
	return summary;
}

/**
 * The single shared rule for executed-test evidence, reused verbatim by the
 * classifier, the aggregation validator, and the cache inspector — no layer
 * may accept what another rejects. A suite genuinely passed only when the
 * footer is complete and consistent (non-negative integers,
 * tests = pass + fail + cancelled + skipped + todo), at least one test
 * actually passed, nothing failed, was cancelled, or is still TODO, and not
 * everything was skipped.
 */
export function evaluateTestEvidence(summary) {
	if (summary === undefined || summary === null || typeof summary !== "object") {
		return { ok: false, reason: "runner produced no test evidence" };
	}
	const counters = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
	if (!counters.every(name => Number.isInteger(summary[name]) && summary[name] >= 0)) {
		return { ok: false, reason: "test evidence is incomplete or malformed" };
	}
	if (summary.tests !== summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo) {
		return { ok: false, reason: "test evidence counters are inconsistent" };
	}
	if (summary.tests === 0 || summary.pass === 0) {
		return { ok: false, reason: "runner did not execute a passing, non-empty suite" };
	}
	if (summary.fail > 0 || summary.cancelled > 0 || summary.todo > 0 || summary.skipped >= summary.tests) {
		return { ok: false, reason: "runner did not execute a fully passing suite" };
	}
	return { ok: true };
}

export function classifyRunnerResult({ status, output = "", error } = {}) {
	if (error || status === null || status === undefined) return { classification: "INFRA_ERROR", reason: "runner failed to start" };
	if (/Unsupported test runtime:/i.test(output)) return { classification: "NOT_VERIFIED", reason: "runner unsupported" };
	const testSummary = parseTestSummary(output);
	/* A test-entry or module load failure is an environment problem, not a
	 * product compatibility assertion: it stays unverified with its source. */
	if (testSummary === undefined && /\bERR_MODULE_NOT_FOUND\b|Cannot find module|^\s*SyntaxError:/im.test(output)) {
		return { classification: "NOT_VERIFIED", reason: "test entry failed to load" };
	}
	const evidence = evaluateTestEvidence(testSummary);
	if (status === 0) {
		/* Exit code 0 alone proves nothing: evidence is the only currency. */
		if (!evidence.ok) return { classification: "NOT_VERIFIED", reason: evidence.reason, ...(testSummary !== undefined ? { testSummary } : {}) };
		return { classification: "COMPATIBLE", reason: "stock compatibility suite passed", testSummary };
	}
	return { classification: "INCOMPATIBLE", reason: "stock compatibility suite failed", ...(testSummary !== undefined ? { testSummary } : {}) };
}

export function sanitizeReportText(value, limit = 500) {
	return String(value ?? "")
		.replace(/[<>]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.split(/\r?\n/, 1)[0]
		.slice(0, limit);
}

export function renderIssueBody(report) {
	const firstFailure = sanitizeReportText(report.firstFailure || "None recorded");
	const runUrl = sanitizeReportText(report.runUrl);
	return [
		...(report.fingerprint ? [`<!-- upstream-compat-fingerprint:${sanitizeReportText(report.fingerprint)} -->`, ""] : []),
		`## ${sanitizeReportText(report.classification)}`,
		"",
		`- Reason: ${sanitizeReportText(report.reason)}`,
		`- Harness tag: \`${sanitizeReportText(report.tag)}\``,
		`- Harness version: \`${sanitizeReportText(report.version)}\``,
		`- Harness commit: \`${sanitizeReportText(report.commit)}\``,
		`- Plugin SHA: \`${sanitizeReportText(report.pluginSha)}\``,
		`- Dependency lock digest: \`${sanitizeReportText(report.dependencyDigest)}\``,
		`- First failure: ${firstFailure}`,
		`- Workflow report: ${runUrl}`,
		"",
		"This is an automated compatibility signal, not a release or upgrade approval. Review the artifact before changing a daily installation.",
	].join("\n");
}
