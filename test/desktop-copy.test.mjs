/**
 * Regression suite for the portable Desktop-copy flow (host-patch/*.mjs).
 *
 * A fixture ".app" (real asar built from this repo's stock 0.2.1-rc.2 libs,
 * shell-script executable) drives the gates and the full darwin build path:
 * wrong version/hash/id targets are refused, dangerous or existing targets
 * are refused, failed builds clean only their own stage, a successful build
 * bakes its own profile/ports, applies 0002/0003 for real, refreshes ASAR
 * integrity, re-ids and re-signs the copy, and leaves the source untouched.
 * Launch isolation: already-running copies are not double-started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as asar from "@electron/asar";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { copyIdentity, EXPECTED, makeDesktopCopy } from "../host-patch/make-desktop-copy.mjs";
import { launchDesktopCopy, readManifest } from "../host-patch/launch-desktop-copy.mjs";
import { checkDesktopCopy } from "../host-patch/check-desktop-copy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isDarwin = process.platform === "darwin";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const STOCK_MAIN = `function developmentEnvironment(development, defaultHarnessPort, env = process.env) {
  if (!development) return { profile: "dsh-desktop", harnessPort: defaultHarnessPort, mobilePort: 43127 };
  const profile = env.DSH_DEV_PROFILE || "dsh-desktop-dev";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profile) || profile === "dsh-desktop") {
    throw new Error("DSH_DEV_PROFILE must be a separate development directory name.");
  }
  const harnessPort = port(env.DSH_DEV_HARNESS_PORT, defaultHarnessPort + 1, "DSH_DEV_HARNESS_PORT");
  const mobilePort = port(env.DSH_DEV_MOBILE_PORT, 43128, "DSH_DEV_MOBILE_PORT");
  if (harnessPort === mobilePort) throw new Error("Development Harness and mobile ports must differ.");
  return { profile, harnessPort, mobilePort };
}
function configureAppIdentity() {
  if (developmentBuild) {
    app.setName("DSH Desktop Dev");
    app.setPath("userData", join(app.getPath("appData"), developmentConfig.profile));
    return;
  }
  app.setName("DSH Desktop");
  app.setPath("userData", join(app.getPath("appData"), "dsh-desktop"));
}
`;

function plist({ version, bundleId }) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>${bundleId}</string>
	<key>CFBundleShortVersionString</key><string>${version}</string>
	<key>CFBundleVersion</key><string>${version}</string>
	<key>ElectronAsarIntegrity</key>
	<dict>
		<key>Resources/app.asar</key>
		<dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>placeholder</string></dict>
	</dict>
</dict>
</plist>
`;
}

async function buildFixtureApp(root, { version = "0.12.1", bundleId = "io.dsh.desktop", harnessVersion = "0.2.1-rc.2", withMarkers = true } = {}) {
	const appPath = join(root, "Source.app");
	mkdirSync(join(appPath, "Contents/MacOS"), { recursive: true });
	mkdirSync(join(appPath, "Contents/Resources"), { recursive: true });
	const exe = join(appPath, "Contents/MacOS/DSH Desktop");
	writeFileSync(exe, "#!/bin/sh\nsleep 30\n");
	chmodSync(exe, 0o755);
	writeFileSync(join(appPath, "Contents/Info.plist"), plist({ version, bundleId }));
	const inner = join(root, "inner");
	mkdirSync(join(inner, "out/main"), { recursive: true });
	writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "dsh-desktop", version: "0.12.1" }, null, 2));
	const main = withMarkers ? STOCK_MAIN : STOCK_MAIN.replace('  const profile = env.DSH_DEV_PROFILE || "dsh-desktop-dev";\n', "");
	if (main === STOCK_MAIN && !withMarkers) throw new Error("fixture marker removal failed");
	writeFileSync(join(inner, "out/main/index.js"), main);
	mkdirSync(join(inner, "native"), { recursive: true });
	writeFileSync(join(inner, "native/native.darwin-arm64.node"), "fake-native-bytes");
	for (const name of EXPECTED.harnessModules) {
		const libDir = join(inner, `node_modules/@deepseek-ai/${name}/lib`);
		mkdirSync(libDir, { recursive: true });
		writeFileSync(join(inner, `node_modules/@deepseek-ai/${name}/package.json`), JSON.stringify({ name: `@deepseek-ai/${name}`, version: harnessVersion }, null, 2));
		writeFileSync(join(libDir, "index.js"), readFileSync(join(repoRoot, "node_modules/@deepseek-ai", name, "lib/index.js")));
	}
	const archive = join(appPath, "Contents/Resources/app.asar");
	await asar.createPackageWithOptions(inner, archive, { unpackDir: "native", unpack: "*.node" });
	return { appPath, archive, archiveSha256: sha256(readFileSync(archive)) };
}

const expectRefusal = async (promise, fragment) => {
	await assert.rejects(promise, (error) => {
		assert.match(error.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		return true;
	});
};

test("copy identity is deterministic, valid, and never the production profile", () => {
	const target = "/Users/x/Example Copy.app";
	const a = copyIdentity(target);
	const b = copyIdentity(target);
	assert.deepEqual(a, b);
	assert.notEqual(a.profile, "dsh-desktop");
	assert.notEqual(a.profile, "dsh-desktop-dev");
	assert.match(a.profile, /^dsh-desktop-compactor-[0-9a-f]{8}$/);
	assert.notEqual(a.harnessPort, a.mobilePort);
	assert.ok(a.harnessPort >= 44000 && a.harnessPort <= 48998);
	assert.notEqual(a.profile, copyIdentity("/Users/x/Different Copy.app").profile);
});

test("readManifest refuses apps without our sidecar manifest", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-copy-test-"));
	try {
		assert.throws(() => readManifest(join(dir, "Nothing.app")), /no sidecar manifest/);
		writeFileSync(join(dir, "Foreign.app.manifest.json"), JSON.stringify({ schema: 9 }));
		assert.throws(() => readManifest(join(dir, "Foreign.app")), /unrecognized manifest/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("makeDesktopCopy refuses non-darwin machines explicitly", { skip: isDarwin }, async () => {
	await expectRefusal(makeDesktopCopy({ source: "/x/A.app", target: "/x/B.app", repoRoot }), "only darwin");
});

test("the verified baseline constants stay pinned", () => {
	assert.equal(EXPECTED.platform, "darwin");
	assert.equal(EXPECTED.arch, "arm64");
	assert.equal(EXPECTED.desktopVersion, "0.12.1");
	assert.equal(EXPECTED.bundleId, "io.dsh.desktop");
	assert.equal(EXPECTED.harnessVersion, "0.2.1-rc.2");
	assert.equal(EXPECTED.archiveSha256.length, 64);
});

test("darwin gates and full build", { skip: !isDarwin }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "dsh-copy-darwin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fixture = await buildFixtureApp(root);
	const out = join(root, "out");
	const target = join(out, "Copy.app");
	const sourceHashBefore = sha256(readFileSync(fixture.archive));
	const run = (options = {}) => makeDesktopCopy({ source: fixture.appPath, target, repoRoot, expected: { archiveSha256: fixture.archiveSha256 }, ...options });

	await t.test("refuses a wrong Desktop version without touching anything", async () => {
		const badRoot = mkdtempSync(join(tmpdir(), "dsh-copy-ver-"));
		try {
			const bad = await buildFixtureApp(badRoot, { version: "0.12.2" });
			await expectRefusal(makeDesktopCopy({ source: bad.appPath, target: join(badRoot, "T.app"), repoRoot, expected: { archiveSha256: bad.archiveSha256 } }), "0.12.2 != verified 0.12.1");
			assert.equal(existsSync(join(badRoot, "T.app")), false);
			assert.equal(existsSync(join(badRoot, "T.app.stage")), false);
		} finally {
			rmSync(badRoot, { recursive: true, force: true });
		}
	});

	await t.test("refuses a wrong bundle id", async () => {
		const badRoot = mkdtempSync(join(tmpdir(), "dsh-copy-bid-"));
		try {
			const bad = await buildFixtureApp(badRoot, { bundleId: "someone.else.app" });
			await expectRefusal(makeDesktopCopy({ source: bad.appPath, target: join(badRoot, "T.app"), repoRoot, expected: { archiveSha256: bad.archiveSha256 } }), "bundle id someone.else.app");
		} finally {
			rmSync(badRoot, { recursive: true, force: true });
		}
	});

	await t.test("refuses absent parents, existing targets, nesting, and leftover stages", async () => {
		await expectRefusal(run(), "target parent directory does not exist");
		mkdirSync(out);
		await expectRefusal(run({ target: join(fixture.appPath, "Contents/Copy.app") }), "must not be inside the source app");
		await expectRefusal(run({ target: fixture.appPath }), "must differ from source");
		mkdirSync(target);
		await expectRefusal(run(), "target already exists");
		rmSync(target, { recursive: true, force: true });
		mkdirSync(`${target}.stage`);
		await expectRefusal(run(), "leftover stage");
		rmSync(`${target}.stage`, { recursive: true, force: true });
	});

	await t.test("refuses an archive that is not the verified baseline", async () => {
		await expectRefusal(run({ expected: { archiveSha256: "0".repeat(64) } }), "!= verified baseline");
	});

	await t.test("refuses a wrong harness lib version", async () => {
		const badRoot = mkdtempSync(join(tmpdir(), "dsh-copy-hv-"));
		try {
			const bad = await buildFixtureApp(badRoot, { harnessVersion: "0.2.1-rc.3" });
			await expectRefusal(makeDesktopCopy({ source: bad.appPath, target: join(badRoot, "T.app"), repoRoot, expected: { archiveSha256: bad.archiveSha256 } }), "0.2.1-rc.3 != 0.2.1-rc.2");
		} finally {
			rmSync(badRoot, { recursive: true, force: true });
		}
	});

	await t.test("a failed build cleans only its own stage and leaves no target", async () => {
		const badRoot = mkdtempSync(join(tmpdir(), "dsh-copy-marker-"));
		try {
			const bad = await buildFixtureApp(badRoot, { withMarkers: false });
			mkdirSync(join(badRoot, "out"));
			const badTarget = join(badRoot, "out", "T.app");
			await expectRefusal(makeDesktopCopy({ source: bad.appPath, target: badTarget, repoRoot, expected: { archiveSha256: bad.archiveSha256 } }), "marker for profile default occurs 0x");
			assert.equal(existsSync(badTarget), false);
			assert.equal(existsSync(`${badTarget}.stage`), false);
		} finally {
			rmSync(badRoot, { recursive: true, force: true });
		}
	});

	await t.test("a successful build applies everything and never writes the source", async (t) => {
		const manifest = await run();
		assert.equal(existsSync(`${target}.manifest.json`), true);
		assert.equal(sha256(readFileSync(fixture.archive)), sourceHashBefore);
		const archive = join(target, "Contents/Resources/app.asar");
		const inner = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
		assert.equal(inner.dshDesktopChannel, "development");
		const main = asar.extractFile(archive, "out/main/index.js").toString("utf8");
		assert.ok(main.includes(`env.DSH_DEV_PROFILE || "${manifest.profile}"`));
		assert.ok(!main.includes('"dsh-desktop-dev"'));
		assert.ok(main.includes(`port(env.DSH_DEV_HARNESS_PORT, ${manifest.harnessPort},`));
		assert.ok(main.includes(`port(env.DSH_DEV_MOBILE_PORT, ${manifest.mobilePort},`));
		assert.ok(main.includes("app.setAppLogsPath"));
		for (const name of EXPECTED.harnessModules) {
			const lib = asar.extractFile(archive, `node_modules/@deepseek-ai/${name}/lib/index.js`).toString("utf8");
			assert.equal(sha256(lib), manifest.patchedModules[name]);
		}
		assert.ok(existsSync(join(target, "Contents/Resources/app.asar.unpacked/native/native.darwin-arm64.node")));
		assert.equal(manifest.originalArchiveSha256, fixture.archiveSha256);
		assert.deepEqual(copyIdentity(target), { profile: manifest.profile, harnessPort: manifest.harnessPort, mobilePort: manifest.mobilePort, suffix: manifest.suffix, bundleId: manifest.bundleId });

		await t.test("a second make against the same target refuses to overwrite", async () => {
			await expectRefusal(run(), "target already exists");
		});

		await t.test("check passes on the fresh copy and catches tampering", () => {
			checkDesktopCopy({ app: target, log: () => {} });
			const manifestPath = `${target}.manifest.json`;
			const original = readFileSync(manifestPath, "utf8");
			const tampered = JSON.parse(original);
			tampered.copiedArchiveHeaderSha256 = "0".repeat(64);
			writeFileSync(manifestPath, JSON.stringify(tampered, null, 2) + "\n");
			assert.throws(() => checkDesktopCopy({ app: target, log: () => {} }), /problem/);
			writeFileSync(manifestPath, original);
			checkDesktopCopy({ app: target, log: () => {} });
		});

		await t.test("launcher refuses foreign apps and never double-starts a copy", () => {
			assert.throws(() => launchDesktopCopy({ app: fixture.appPath, log: () => {} }), /no sidecar manifest/);
			assert.throws(() => launchDesktopCopy({ app: target, debugPort: 999, log: () => {} }), /debugPort/);
			const exe = join(target, "Contents/MacOS/DSH Desktop");
			const first = spawn(exe, [], { stdio: "ignore" });
			try {
				const result = launchDesktopCopy({ app: target, log: () => {} });
				assert.equal(result.alreadyRunning, true);
				assert.ok(result.pids.includes(first.pid));
			} finally {
				process.kill(first.pid, "SIGTERM");
			}
			const launched = launchDesktopCopy({ app: target, log: () => {} });
			assert.equal(launched.alreadyRunning, false);
			assert.ok(launched.childPid > 0);
			process.kill(launched.childPid, 0);
			process.kill(launched.childPid, "SIGTERM");
		});
	});
});
