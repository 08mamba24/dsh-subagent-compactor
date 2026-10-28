#!/usr/bin/env node
/**
 * Verify a copy made by make-desktop-copy.mjs: manifest, archive integrity,
 * baked identity, patched-module hashes, signature, and that the ORIGINAL
 * installed app still matches the verified baseline (informational).
 *
 * Usage: node host-patch/check-desktop-copy.mjs --app "/path/Copy.app"
 */
import * as asar from "@electron/asar";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readManifest } from "./launch-desktop-copy.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function plibRead(appPath, key) {
	return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim();
}

export function checkDesktopCopy({ app, log = console.log }) {
	if (process.platform !== "darwin") throw new Error(`only darwin is supported; this machine is ${process.platform}`);
	app = resolve(app);
	const manifest = readManifest(app);
	const archive = join(app, "Contents/Resources/app.asar");
	const problems = [];
	if (!existsSync(app)) problems.push(`app bundle missing: ${app}`);
	if (problems.length === 0) {
		const headerHash = sha256(asar.getRawHeader(archive).headerString);
		if (headerHash !== manifest.copiedArchiveHeaderSha256) problems.push("copy archive header hash differs from the manifest");
		const plistHash = plibRead(app, "ElectronAsarIntegrity:Resources/app.asar:hash");
		if (plistHash !== headerHash) problems.push(`Info.plist integrity hash ${plistHash} != archive header hash ${headerHash}`);
		const bundleId = plibRead(app, "CFBundleIdentifier");
		if (bundleId !== manifest.bundleId) problems.push(`bundle id ${bundleId} != ${manifest.bundleId}`);
		for (const [name, expectedHash] of Object.entries(manifest.patchedModules)) {
			const lib = asar.extractFile(archive, `node_modules/@deepseek-ai/${name}/lib/index.js`).toString("utf8");
			if (sha256(lib) !== expectedHash) problems.push(`patched module ${name} hash differs from the manifest`);
		}
		const main = asar.extractFile(archive, "out/main/index.js").toString("utf8");
		if (main.includes("env.DSH_DEV_PROFILE")) problems.push("copy main still honors DSH_DEV_PROFILE; the baked identity is not env-proof");
		if (!main.includes(`const profile = "${manifest.profile}";`)) problems.push("baked profile literal missing from the copy main");
		if (!main.includes(`const harnessPort = ${manifest.harnessPort};`)) problems.push("baked harness port literal missing from the copy main");
		if (!main.includes(`const mobilePort = ${manifest.mobilePort};`)) problems.push("baked mobile port literal missing from the copy main");
		try {
			execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
		} catch {
			problems.push("codesign --verify failed on the copy");
		}
	}
	const sourceArchive = join(manifest.original, "Contents/Resources/app.asar");
	if (existsSync(sourceArchive)) {
		const sourceHash = sha256(readFileSync(sourceArchive));
		if (sourceHash !== manifest.originalArchiveSha256) problems.push(`the ORIGINAL app archive changed (now ${sourceHash}) — the copy is still the verified build, but the installed app is not the baseline`);
		log(`Original app archive: ${sourceHash === manifest.originalArchiveSha256 ? "unchanged (verified baseline)" : "CHANGED"}`);
	} else {
		log(`Original app not found at ${manifest.original} (informational).`);
	}
	log(`Copy: ${app}`);
	log(`Profile: ${manifest.profile}  harnessPort: ${manifest.harnessPort}  mobilePort: ${manifest.mobilePort}  bundleId: ${manifest.bundleId}`);
	if (problems.length > 0) {
		for (const problem of problems) log(`PROBLEM: ${problem}`);
		throw new Error(`${problems.length} problem(s) found`);
	}
	log("All checks passed.");
	return { ok: true };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	const app = process.argv[process.argv.indexOf("--app") + 1];
	try {
		if (!app) throw new Error("usage: node host-patch/check-desktop-copy.mjs --app <app>");
		checkDesktopCopy({ app });
	} catch (error) {
		console.error(`check-desktop-copy failed: ${error.message}`);
		process.exitCode = 1;
	}
}
