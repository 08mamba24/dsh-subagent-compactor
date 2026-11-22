#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectUpstreamCandidates } from "./lib/upstream-compat-core.mjs";

function parseArgs(argv) {
	const result = {
		repository: "deepseek-ai/deepseek-harness",
		limit: 3,
		output: "upstream-discovery.json",
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (arg === "--repository") result.repository = value, index++;
		else if (arg === "--limit") result.limit = Number(value), index++;
		else if (arg === "--tag") result.requestedTag = value, index++;
		else if (arg === "--output") result.output = value, index++;
		else if (arg === "--github-output") result.githubOutput = value, index++;
		else if (arg === "--releases-file") result.releasesFile = value, index++;
		else if (arg === "--tags-file") result.tagsFile = value, index++;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)) throw new Error("Invalid GitHub repository name");
	if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20) throw new Error("--limit must be an integer from 1 to 20");
	if (result.requestedTag !== undefined && !/^dsh-v[0-9A-Za-z.-]+$/.test(result.requestedTag)) throw new Error("Invalid --tag");
	if (Boolean(result.releasesFile) !== Boolean(result.tagsFile)) throw new Error("Fixture mode requires both --releases-file and --tags-file");
	return result;
}

function nextLink(header) {
	for (const part of (header ?? "").split(",")) {
		const match = part.match(/<([^>]+)>;\s*rel="next"/);
		if (match) return match[1];
	}
}

async function githubPages(url, token) {
	const values = [];
	let next = url;
	while (next) {
		const response = await fetch(next, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "dsh-subagent-compactor-upstream-watch",
				"x-github-api-version": "2022-11-28",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`GitHub API ${response.status} for ${new URL(next).pathname}`);
		const page = await response.json();
		if (!Array.isArray(page)) throw new Error(`Expected a GitHub array for ${new URL(next).pathname}`);
		values.push(...page);
		next = nextLink(response.headers.get("link"));
	}
	return values;
}

function writeGithubOutput(path, name, value) {
	if (!path) return;
	if (/\r|\n/.test(value)) throw new Error(`GitHub output ${name} must be one line`);
	appendFileSync(path, `${name}=${value}\n`);
}

const args = parseArgs(process.argv.slice(2));
const [releases, tags] = args.releasesFile
	? [JSON.parse(readFileSync(resolve(args.releasesFile), "utf8")), JSON.parse(readFileSync(resolve(args.tagsFile), "utf8"))]
	: await Promise.all([
		githubPages(`https://api.github.com/repos/${args.repository}/releases?per_page=100`, process.env.GITHUB_TOKEN),
		githubPages(`https://api.github.com/repos/${args.repository}/tags?per_page=100`, process.env.GITHUB_TOKEN),
	]);
const candidates = selectUpstreamCandidates({ releases, tags, limit: args.limit, requestedTag: args.requestedTag });
const result = {
	discoveredAt: new Date().toISOString(),
	repository: args.repository,
	requestedTag: args.requestedTag ?? null,
	candidates,
};
writeFileSync(resolve(args.output), JSON.stringify(result, null, 2) + "\n");
const matrix = {
	include: candidates.map(candidate => ({
		...candidate,
		artifact: candidate.tag.replace(/[^A-Za-z0-9_.-]/g, "-"),
	})),
};
writeGithubOutput(args.githubOutput, "matrix", JSON.stringify(matrix));
writeGithubOutput(args.githubOutput, "expected_targets", JSON.stringify(candidates.map(({ tag, version, commit }) => ({ tag, version, commit }))));
writeGithubOutput(args.githubOutput, "has_candidates", String(candidates.length > 0));
writeGithubOutput(args.githubOutput, "candidate_count", String(candidates.length));
console.log(JSON.stringify(result, null, 2));
