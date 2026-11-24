/** Test-only adaptation of activation specs; no runtime service is patched. */
import assert from "node:assert/strict";
const names = new WeakMap();

/**
 * Announce a host row that failed before the plugin under test was imported.
 * The upstream watcher matches this leading line in
 * scripts/lib/upstream-compat-core.mjs and attributes the run to the host.
 */
export function reportHostAssemblyFailure(stage, error) {
	const name = `${error?.name ?? "Error"}${error?.code ? ` [${error.code}]` : ""}`;
	console.error(`DSH_HOST_ASSEMBLY_FAILED ${stage}: ${name}: ${String(error?.message ?? error).split(/\r?\n/, 1)[0]}`);
}

/** Stands in for a host row, or for the plugin under test, without touching any service. */
export const INERT_MODULE = { apply() {} };

/** A `hostModules` override in which every row not named in `overrides` answers with an inert module. */
export function inertHost(overrides) {
	return new Proxy(overrides, { get: (rows, name) => rows[name] ?? INERT_MODULE });
}

const listeners = new Set();

/** Track a fixture HTTP listener so one that outlives its test is caught by releaseLeakedFixtureListeners. */
export function trackFixtureListener(server) {
	listeners.add(server);
	server.on("close", () => listeners.delete(server));
	return server;
}

/**
 * Root after-hook body. A listener left behind by a failed composition used to
 * keep `node --test` alive until the watcher's deadline, which reported an
 * upstream host fault as INFRA_ERROR and never printed why: close what leaked,
 * then fail on it.
 */
export async function releaseLeakedFixtureListeners() {
	const leaked = [...listeners].filter((server) => server.listening);
	await Promise.all(leaked.map((server) => new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	})));
	assert.deepEqual(leaked, [], `${leaked.length} fixture HTTP listener(s) outlived their test`);
}

/** Optional auth service for the stock alpha.1+ API-key provider. */
export async function loadDeepSeekAuth() {
	let entry;
	try { entry = import.meta.resolve("@deepseek-ai/dsh-deepseek-auth"); }
	catch (error) {
		if (error.code === "ERR_MODULE_NOT_FOUND"
			&& error.message.startsWith("Cannot find package '@deepseek-ai/dsh-deepseek-auth' imported from ")) return undefined;
		throw error;
	}
	// Import outside the resolution catch: broken transitive imports must fail.
	return import(entry);
}

export function startActivation(ctx, spec) {
	if (typeof ctx.subagents.listChildren === "function") return ctx.subagents.startActivation(spec);
	const index = (names.get(ctx) ?? 0) + 1;
	names.set(ctx, index);
	const { request, ...options } = spec;
	return ctx.subagents.startActivation({ ...options, ...request, name: `worker-${index}`, maxDepth: 3 });
}

/** Independent fixture observation of the creator's catalog on either host. */
export async function directCatalog(ctx, parentId) {
	if (typeof ctx.subagents.listChildren === "function") return ctx.subagents.listChildren(parentId);
	const observation = await ctx.sessionQuery.observeSession(parentId);
	try { return observation.projections.values.subagentCatalog.map((entry) => ({ ...entry })); }
	finally { observation[Symbol.dispose](); }
}
