#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportedVersions = new Set(["0.2.2-rc.1", "0.2.2-rc.2"]);
const tests = ["authorization.test.mjs", "unit.test.mjs", "batch.test.mjs", "integration.test.mjs", "preset-integration.test.mjs"];
const modulesRequired = [
	"cordis", "cordis-plugin-loader", "cordis-plugin-timer", "schemastery",
	"dsh-agent", "dsh-agent-loop", "dsh-agent-preset", "dsh-agent-preset-registry",
	"dsh-compaction-basic", "dsh-command-compact", "dsh-commands", "dsh-fs-local",
	"dsh-llm", "dsh-llm-deepseek-api-key", "dsh-session", "dsh-session-projection",
	"dsh-session-persistence-jsonl", "dsh-session-query", "dsh-subagent",
	"dsh-subagent-spawn-in-process", "dsh-system-prompt", "dsh-token-meter",
	"dsh-tool-executor-native", "dsh-tools", "dsh-working-directory"
];

let scratch;
try {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 24 || (major === 24 && minor < 9)) throw new Error("Node >=24.9 is required.");
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== "--modules" || !isAbsolute(args[1])) {
		throw new Error("Usage: node scripts/test-installed-runtime.mjs --modules /absolute/node_modules");
	}
	const modules = realpathSync(args[1]);
	if (!statSync(modules).isDirectory()) throw new Error(`Not a module directory: ${modules}`);
	const version = JSON.parse(readFileSync(join(modules, "@deepseek-ai/dsh-subagent/package.json"), "utf8")).version;
	if (!supportedVersions.has(version)) throw new Error(`Unsupported test runtime: ${version}`);
	for (const name of modulesRequired) {
		const directory = join(modules, "@deepseek-ai", name);
		if (!statSync(directory).isDirectory()) throw new Error(`Missing module directory: ${directory}`);
		const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (pkg.name !== `@deepseek-ai/${name}`) throw new Error(`Unexpected package at ${directory}`);
		if (name.startsWith("dsh-") && pkg.version !== version) {
			throw new Error(`${pkg.name}: expected ${version}, found ${pkg.version}`);
		}
	}

	const source = fileURLToPath(new URL("../", import.meta.url));
	scratch = mkdtempSync(join(tmpdir(), "dsh-subagent-compactor-tests-"));
	for (const directory of ["test", "harness", "agents"]) mkdirSync(join(scratch, directory));
	for (const file of ["index.js", "package.json", "test/runtime-fixture.mjs", ...tests.map((name) => `test/${name}`)]) {
		copyFileSync(join(source, file), join(scratch, file));
	}
	symlinkSync(modules, join(scratch, "node_modules"), "dir");
	console.log(`Node ${process.versions.node}; DSH ${version}; modules: ${modules}`);
	console.log(`Running ${tests.length} test files in isolated scratch: ${scratch}`);
	const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", "--test-reporter=spec", ...tests.map((name) => `test/${name}`)], {
		cwd: scratch,
		stdio: "inherit",
		env: { ...process.env, DSH_HOME: join(scratch, "harness"), DSH_AGENTS_HOME: join(scratch, "agents") }
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
}
