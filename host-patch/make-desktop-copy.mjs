#!/usr/bin/env node
/**
 * Make an independent, host-patched copy of the official DSH Desktop app.
 *
 * macOS arm64 only. Declared and verified baseline:
 *   Desktop 0.12.1, Harness 0.2.1-rc.2, app.asar SHA256 below.
 * Any mismatch refuses explicitly — no fuzzy adaptation to other builds.
 *
 * The copy (never the source) gets: host-patch/0002 + 0003 applied to the
 * extracted stock libs, the development channel, a per-copy profile/port
 * default baked into the app (so a bare double-click can never land on the
 * production profile), a unique bundle id, refreshed ASAR integrity, and an
 * ad-hoc signature. Every build step happens inside a stage directory that is
 * removed on failure; the target path only appears via one final rename.
 *
 * Usage:
 *   node host-patch/make-desktop-copy.mjs \
 *     --source "/Applications/DSH Desktop.app" \
 *     --target "/path/DSH Desktop Compactor.app"
 */
import * as asar from "@electron/asar";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_VERSION = 1;
export const EXPECTED = {
	platform: "darwin",
	arch: "arm64",
	desktopVersion: "0.12.1",
	bundleId: "io.dsh.desktop",
	archiveSha256: "366bef4146e0a41227c6c96b39e621f21b08b93aeb7e21d5fc18bb5358fefaaa",
	harnessVersion: "0.2.1-rc.2",
	harnessModules: ["dsh-agent-loop", "dsh-subagent"],
	copyBundleIdPrefix: "io.dsh.desktop.compactor-",
};

/** Markers that must each occur exactly once in the stock main bundle. */
export const MAIN_MARKERS = {
	userData: 'app.setPath("userData", join(app.getPath("appData"), developmentConfig.profile));',
	profileDefault: 'const profile = env.DSH_DEV_PROFILE || "dsh-desktop-dev";',
	harnessPortDefault: 'const harnessPort = port(env.DSH_DEV_HARNESS_PORT, defaultHarnessPort + 1, "DSH_DEV_HARNESS_PORT");',
	mobilePortDefault: 'const mobilePort = port(env.DSH_DEV_MOBILE_PORT, 43128, "DSH_DEV_MOBILE_PORT");',
};
const LOGS_LINE = 'app.setAppLogsPath(join(app.getPath("userData"), "logs"));';
/** Semantic proof the runtime patches are present after applying 0002/0003. */
const LIB_PATCHES = {
	"dsh-agent-loop": { diff: "0002-agent-loop-lib.equivalent.diff", proof: "closeInput" },
	"dsh-subagent": { diff: "0003-dsh-subagent-lib.equivalent.diff", proof: "runMaintenance" },
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));

function fail(message) {
	throw new Error(message);
}

function plibRead(appPath, key) {
	return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim();
}

function plibSet(appPath, key, value) {
	execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, join(appPath, "Contents/Info.plist")]);
}

/** Deterministic per-target identity: stable profile name and port pair. */
export function copyIdentity(targetPath, prefix = EXPECTED.copyBundleIdPrefix) {
	const h8 = sha256(resolve(targetPath)).slice(0, 8);
	const profile = `dsh-desktop-compactor-${h8}`;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profile) || profile === "dsh-desktop") fail("generated profile name is invalid");
	const harnessPort = 44000 + (parseInt(h8.slice(0, 4), 16) % 2500) * 2;
	const mobilePort = harnessPort + 1;
	return { profile, harnessPort, mobilePort, suffix: h8, bundleId: `${prefix}${h8}` };
}

function assertPaths({ source, target }) {
	if (!isAbsolute(source) || !isAbsolute(target)) fail("--source and --target must be absolute paths");
	if (!source.endsWith(".app") || !target.endsWith(".app")) fail("both --source and --target must be .app bundles");
	const sourceStat = existsSync(source) && statSync(source).isDirectory();
	if (!sourceStat) fail(`source app not found: ${source}`);
	const archive = join(source, "Contents/Resources/app.asar");
	if (!existsSync(archive)) fail(`source has no Contents/Resources/app.asar: ${source}`);
	if (source === target) fail("target must differ from source");
	const relToSource = relative(source, target);
	const relToTarget = relative(target, source);
	if (relToSource === "" || (!relToSource.startsWith("..") && relToSource !== "")) fail("target must not be inside the source app");
	if (!relToTarget.startsWith("..") && relToTarget !== "") fail("source must not be inside the target path");
	if (existsSync(target)) fail(`target already exists — this script never overwrites; move it away first: ${target}`);
	const stage = `${target}.stage`;
	if (existsSync(stage)) fail(`leftover stage from an earlier run exists — inspect and delete it first: ${stage}`);
	const parent = dirname(target);
	if (!existsSync(parent)) fail(`target parent directory does not exist: ${parent}`);
	if (parent === "/" || parent === source) fail(`target parent must be a normal user directory, not ${parent}`);
	return { archive, stage };
}

function assertBaseline({ source, archive }, gate) {
	const version = plibRead(source, "CFBundleShortVersionString");
	if (version !== gate.desktopVersion) fail(`Desktop version ${version} != verified ${gate.desktopVersion}; refusing (no fuzzy adaptation)`);
	const bundleId = plibRead(source, "CFBundleIdentifier");
	if (bundleId !== gate.bundleId) fail(`bundle id ${bundleId} != ${gate.bundleId}; refusing`);
	const archiveHash = sha256File(archive);
	if (archiveHash !== gate.archiveSha256) fail(`app.asar SHA256 ${archiveHash} != verified baseline ${gate.archiveSha256}; refusing`);
	const inner = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
	if (inner.version !== gate.desktopVersion) fail(`inner package version ${inner.version} != ${gate.desktopVersion}; refusing`);
	for (const name of EXPECTED.harnessModules) {
		const pkg = JSON.parse(asar.extractFile(archive, `node_modules/@deepseek-ai/${name}/package.json`).toString("utf8"));
		if (pkg.version !== gate.harnessVersion) fail(`${name} ${pkg.version} != ${gate.harnessVersion}; refusing`);
	}
	return archiveHash;
}

/** Replace a marker that must occur exactly once; refuse on drift. */
function replaceOnce(content, marker, replacement, label) {
	const count = content.split(marker).length - 1;
	if (count !== 1) fail(`main bundle marker for ${label} occurs ${count}x (expected 1); the app build differs from the verified baseline`);
	return content.replace(marker, replacement);
}

function patchMainBundle(extracted, identity) {
	const mainPath = join(extracted, "out/main/index.js");
	let main = readFileSync(mainPath, "utf8");
	if (main.includes(LOGS_LINE)) fail("main bundle already contains the logs patch; refusing to patch twice");
	main = replaceOnce(main, MAIN_MARKERS.userData, `${MAIN_MARKERS.userData}\n    ${LOGS_LINE}`, "userData redirect");
	main = replaceOnce(main, MAIN_MARKERS.profileDefault, `const profile = env.DSH_DEV_PROFILE || "${identity.profile}";`, "profile default");
	main = replaceOnce(main, MAIN_MARKERS.harnessPortDefault, `const harnessPort = port(env.DSH_DEV_HARNESS_PORT, ${identity.harnessPort}, "DSH_DEV_HARNESS_PORT");`, "harness port default");
	main = replaceOnce(main, MAIN_MARKERS.mobilePortDefault, `const mobilePort = port(env.DSH_DEV_MOBILE_PORT, ${identity.mobilePort}, "DSH_DEV_MOBILE_PORT");`, "mobile port default");
	writeFileSync(mainPath, main);
}

function setDevelopmentChannel(extracted) {
	const pkgPath = join(extracted, "package.json");
	const metadata = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (metadata.dshDesktopChannel !== undefined) fail(`source channel is already ${JSON.stringify(metadata.dshDesktopChannel)}; refusing`);
	metadata.dshDesktopChannel = "development";
	writeFileSync(pkgPath, JSON.stringify(metadata, null, 2) + "\n");
}

function applyLibPatches(extracted, repoRoot) {
	const hashes = {};
	for (const [name, { diff, proof }] of Object.entries(LIB_PATCHES)) {
		const relativeLib = `node_modules/@deepseek-ai/${name}/lib/index.js`;
		const libPath = join(extracted, relativeLib);
		let output;
		try {
			output = execFileSync("/usr/bin/patch", [libPath], { input: readFileSync(join(repoRoot, "host-patch", diff)) }).toString("utf8");
		} catch (error) {
			fail(`patching ${name} failed: ${error.stdout?.toString() ?? ""} ${error.message}`);
		}
		if (/fuzz|offset|FAILED|Reversed/i.test(output)) fail(`patching ${name} was not clean (fuzz/offset/failure) — build drift; output: ${output.trim()}`);
		const patched = readFileSync(libPath, "utf8");
		if (!patched.includes(proof)) fail(`patched ${name} lacks ${proof}; refusing`);
		hashes[name] = sha256(patched);
	}
	return hashes;
}

/** Walk the original asar header so the repack preserves every unpacked root/file. */
function unpackedLayout(archive) {
	const raw = asar.getRawHeader(archive);
	const dirs = [];
	const files = [];
	(function walk(node, prefix = "") {
		if (node.unpacked && node.files) {
			dirs.push(prefix);
			return;
		}
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			const path = prefix ? `${prefix}/${name}` : name;
			if (entry.files) walk(entry, path);
			else if (entry.unpacked) files.push(path);
		}
	})(raw.header);
	return { dirs, files };
}

/**
 * `expected` overrides the verified baseline (used by the regression suite's
 * fixture app; the CLI always ships the real constants).
 */
export async function makeDesktopCopy({ source, target, repoRoot, expected = {}, log = console.error }) {
	if (process.platform !== EXPECTED.platform) fail(`only ${EXPECTED.platform}/${EXPECTED.arch} is supported; this machine is ${process.platform}/${process.arch}`);
	if (process.arch !== EXPECTED.arch) fail(`only ${EXPECTED.platform}/${EXPECTED.arch} is supported; this machine is ${process.platform}/${process.arch}`);
	const gate = { ...EXPECTED, ...expected };
	const { archive, stage } = assertPaths({ source, target });
	const archiveHashBefore = assertBaseline({ source, archive }, gate);
	const identity = copyIdentity(target, gate.copyBundleIdPrefix);
	const bundleId = identity.bundleId;
	mkdirSync(stage);
	const extracted = join(stage, "extracted");
	const builtApp = join(stage, "app");
	let manifest;
	try {
		log(`Cloning ${source} into the stage directory (the source is never written).`);
		execFileSync("/bin/cp", ["-cR", source, builtApp], { stdio: "inherit" });
		asar.extractAll(archive, extracted);
		setDevelopmentChannel(extracted);
		patchMainBundle(extracted, identity);
		const patchedModules = applyLibPatches(extracted, repoRoot);
		log("Repacking the archive; preserving the original unpacked layout.");
		const { dirs, files } = unpackedLayout(archive);
		const targetArchive = join(builtApp, "Contents/Resources/app.asar");
		await asar.createPackageWithOptions(extracted, targetArchive, {
			unpackDir: `{${dirs.join(",")}}`,
			unpack: `{${files.join(",")}}`,
		});
		const headerHash = sha256(asar.getRawHeader(targetArchive).headerString);
		plibSet(builtApp, "ElectronAsarIntegrity:Resources/app.asar:hash", headerHash);
		plibSet(builtApp, "CFBundleIdentifier", bundleId);
		log("Ad-hoc signing ONLY the staged copy.");
		execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", builtApp], { stdio: "inherit" });
		execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", builtApp], { stdio: "inherit" });
		if (sha256File(archive) !== archiveHashBefore) fail("the source archive changed during the build; aborting");
		renameSync(builtApp, target);
		manifest = {
			schema: 1,
			madeBy: "host-patch/make-desktop-copy.mjs",
			scriptVersion: SCRIPT_VERSION,
			createdAt: new Date().toISOString(),
			original: source,
			target,
			desktopVersion: EXPECTED.desktopVersion,
			harnessVersion: EXPECTED.harnessVersion,
			originalArchiveSha256: archiveHashBefore,
			copiedArchiveHeaderSha256: headerHash,
			patchedModules,
			profile: identity.profile,
			suffix: identity.suffix,
			harnessPort: identity.harnessPort,
			mobilePort: identity.mobilePort,
			bundleId,
			codesign: "ad-hoc",
		};
	} catch (error) {
		rmSync(stage, { recursive: true, force: true });
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		throw error;
	}
	rmSync(stage, { recursive: true, force: true });
	writeFileSync(`${target}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
	log(`Copy ready: ${target}`);
	log(`Profile: ${identity.profile}  harnessPort: ${identity.harnessPort}  mobilePort: ${identity.mobilePort}  bundleId: ${bundleId}`);
	return manifest;
}

function parseArgs(argv) {
	const options = { source: "/Applications/DSH Desktop.app", target: undefined };
	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--source") options.source = resolve(argv[++index]);
		else if (argument === "--target") options.target = resolve(argv[++index]);
		else fail(`unknown argument: ${argument}`);
	}
	if (!options.target) fail("usage: node host-patch/make-desktop-copy.mjs --source <app> --target <app>");
	return options;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	const options = parseArgs(process.argv);
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	makeDesktopCopy({ ...options, repoRoot }).catch((error) => {
		console.error(`make-desktop-copy failed: ${error.message}`);
		process.exitCode = 1;
	});
}
