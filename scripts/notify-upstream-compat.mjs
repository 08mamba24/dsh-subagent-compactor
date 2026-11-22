#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { renderIssueBody, sanitizeReportText, sha256, TERMINAL_CLASSIFICATIONS } from "./lib/upstream-compat-core.mjs";

function parseArgs(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index], value = argv[index + 1];
		if (arg === "--aggregate") result.aggregate = value, index++;
		else if (arg === "--repository") result.repository = value, index++;
		else if (arg === "--run-url") result.runUrl = value, index++;
		else if (arg === "--output") result.output = value, index++;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!result.aggregate || !result.repository || !result.runUrl || !result.output) throw new Error("--aggregate, --repository, --run-url, and --output are required");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)) throw new Error("Invalid repository");
	return result;
}

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `gh exited ${result.status}`);
	return result.stdout;
}

const args = parseArgs(process.argv.slice(2));
const aggregate = JSON.parse(readFileSync(resolve(args.aggregate), "utf8"));
const existing = JSON.parse(gh(["issue", "list", "--repo", args.repository, "--state", "all", "--limit", "1000", "--json", "number,title,state,body"]));
const byTitle = new Map(existing.map(issue => [issue.title, issue]));
const temporary = mkdtempSync(join(tmpdir(), "dsh-upstream-notify-"));
const actions = [];
try {
	for (const entry of aggregate.reports) {
		/* Delivery follows the EFFECTIVE verdict: a cached (SKIPPED) result
		 * still owes an issue until its fingerprint has actually been
		 * delivered — testing was skipped, notification was not. */
		const report = entry.classification === "SKIPPED"
			? { ...entry, classification: entry.previousClassification, reason: entry.previousReason ?? entry.reason }
			: entry;
		if (report.classification === "PREPARED" || !TERMINAL_CLASSIFICATIONS.includes(report.classification)) continue;
		const tag = sanitizeReportText(report.tag, 100);
		if (!/^dsh-v[0-9A-Za-z.-]+$/.test(tag)) throw new Error(`Unsafe report tag: ${tag}`);
		const title = `[upstream-compat] ${tag}`;
		const issue = byTitle.get(title);
		if (report.classification === "COMPATIBLE" && !issue) {
			actions.push({ tag, action: "healthy", classification: report.classification });
			continue;
		}
		const bodyPath = join(temporary, `${tag}.md`);
		const fingerprint = sha256(JSON.stringify({
			classification: report.classification,
			reason: report.reason,
			tag: report.tag,
			version: report.version,
			commit: report.commit,
			pluginSha: report.pluginSha,
			dependencyDigest: report.dependencyDigest,
			firstFailure: report.firstFailure,
		}));
		const body = renderIssueBody({ ...report, runUrl: args.runUrl, fingerprint }) + "\n";
		writeFileSync(bodyPath, body);
		if (issue) {
			if (issue.body?.includes(`<!-- upstream-compat-fingerprint:${fingerprint} -->`)) {
				if (report.classification === "COMPATIBLE" && issue.state === "OPEN") {
					gh(["issue", "close", String(issue.number), "--repo", args.repository]);
					actions.push({ tag, action: "resolved", number: issue.number, classification: report.classification });
					continue;
				}
				actions.push({ tag, action: "unchanged", number: issue.number, classification: report.classification });
				continue;
			}
			gh(["issue", "edit", String(issue.number), "--repo", args.repository, "--title", title, "--body-file", bodyPath]);
			if (report.classification === "COMPATIBLE") {
				if (issue.state === "OPEN") gh(["issue", "close", String(issue.number), "--repo", args.repository]);
				actions.push({ tag, action: "resolved", number: issue.number, classification: report.classification });
				continue;
			}
			if (issue.state === "CLOSED") gh(["issue", "reopen", String(issue.number), "--repo", args.repository]);
			actions.push({ tag, action: "updated", number: issue.number, classification: report.classification });
		} else {
			const url = gh(["issue", "create", "--repo", args.repository, "--title", title, "--body-file", bodyPath]).trim();
			actions.push({ tag, action: "created", url, classification: report.classification });
		}
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
writeFileSync(resolve(args.output), JSON.stringify({ notifiedAt: new Date().toISOString(), actions }, null, 2) + "\n");
console.log(JSON.stringify({ actions }, null, 2));
