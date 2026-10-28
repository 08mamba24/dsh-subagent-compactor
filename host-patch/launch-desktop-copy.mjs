#!/usr/bin/env node
/**
 * Launch a copy made by make-desktop-copy.mjs.
 *
 * Launches the copy's executable directly (env survives; `open` would strip
 * it) with the copy's baked profile/port defaults, so launching here and a
 * bare double-click land on the same isolated profile. Refuses apps without
 * our sidecar manifest. If the copy is already running, says so and exits 0 —
 * it never starts a second instance against the same profile.
 *
 * The remote-debugging port is OFF by default and only added with an explicit
 * --debug-port (acceptance/debug use).
 *
 * Usage:
 *   node host-patch/launch-desktop-copy.mjs --app "/path/Copy.app" [--debug-port 9222]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export function readManifest(appPath) {
	const manifestPath = `${resolve(appPath)}.manifest.json`;
	if (!existsSync(manifestPath)) {
		throw new Error(`no sidecar manifest next to ${appPath}; only launch copies made by host-patch/make-desktop-copy.mjs`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schema !== 1 || manifest.madeBy !== "host-patch/make-desktop-copy.mjs") {
		throw new Error(`unrecognized manifest schema at ${manifestPath}`);
	}
	return manifest;
}

function runningPids(execPath) {
	let candidates = [];
	try {
		const out = execFileSync("/usr/bin/pgrep", ["-f", execPath.replace(/[.+?^${}()|[\]\\]/g, "\\$&")], { encoding: "utf8" }).trim();
		candidates = out ? out.split("\n").map(Number) : [];
	} catch {
		return [];
	}
	const pids = [];
	for (const pid of candidates) {
		let command = "";
		try {
			command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
		} catch {
			continue;
		}
		if (command === execPath || command.startsWith(`${execPath} `) || command.endsWith(execPath) || command.includes(` ${execPath} `)) pids.push(pid);
	}
	return pids;
}

export function launchDesktopCopy({ app, debugPort, log = console.log, env = process.env }) {
	if (process.platform !== "darwin") throw new Error(`only darwin is supported; this machine is ${process.platform}`);
	if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535)) {
		throw new Error("debugPort must be an integer from 1024 to 65535");
	}
	app = resolve(app);
	if (!existsSync(app) || !existsSync(join(app, "Contents/MacOS"))) throw new Error(`app bundle not found: ${app}`);
	const manifest = readManifest(app);
	const execPath = join(app, "Contents/MacOS", "DSH Desktop");
	if (!existsSync(execPath)) throw new Error(`executable not found: ${execPath}`);
	const pids = runningPids(execPath);
	if (pids.length > 0) {
		log(`Already running (pid ${pids.join(", ")}) — profile ${manifest.profile} keeps a single instance; not starting another.`);
		return { alreadyRunning: true, pids };
	}
	const args = debugPort ? ["--remote-debugging-port", String(debugPort)] : [];
	// The copy's identity is baked into its app bundle; identity-shaped env
	// vars are stripped so an inherited shell can never redirect this copy to
	// some other development profile.
	const childEnv = { ...env };
	delete childEnv.DSH_DEV_PROFILE;
	delete childEnv.DSH_DEV_HARNESS_PORT;
	delete childEnv.DSH_DEV_MOBILE_PORT;
	const child = spawn(execPath, args, { detached: true, stdio: "ignore", env: childEnv });
	child.unref();
	log(`Launched ${app}`);
	log(`Profile: ${manifest.profile}  harnessPort: ${manifest.harnessPort}  mobilePort: ${manifest.mobilePort}`);
	log(`User data: ~/Library/Application Support/${manifest.profile}`);
	if (debugPort) log(`Remote debugging: 127.0.0.1:${debugPort} (explicitly enabled)`);
	return { alreadyRunning: false, childPid: child.pid };
}

function parseArgs(argv) {
	const options = { app: undefined, debugPort: undefined };
	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--app") options.app = argv[++index];
		else if (argument === "--debug-port") options.debugPort = Number(argv[++index]);
		else throw new Error(`unknown argument: ${argument}`);
	}
	if (!options.app) throw new Error("usage: node host-patch/launch-desktop-copy.mjs --app <app> [--debug-port <port>]");
	if (options.debugPort !== undefined && (!Number.isInteger(options.debugPort) || options.debugPort < 1024 || options.debugPort > 65535)) {
		throw new Error("--debug-port must be an integer from 1024 to 65535");
	}
	return options;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	try {
		launchDesktopCopy(parseArgs(process.argv));
	} catch (error) {
		console.error(`launch-desktop-copy failed: ${error.message}`);
		process.exitCode = 1;
	}
}
