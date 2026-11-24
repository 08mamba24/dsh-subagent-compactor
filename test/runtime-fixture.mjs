/** Test-only adaptation of activation specs; no runtime service is patched. */
const names = new WeakMap();

/** One failure as one line: `Name [code]: first line of the message`. */
function describe(error) {
	const name = `${error?.name ?? "Error"}${error?.code ? ` [${error.code}]` : ""}`;
	return `${name}: ${String(error?.message ?? error).split(/\r?\n/, 1)[0]}`;
}

/** How many of the host's own frames an announcement keeps; the first ones are inside the host. */
const HOST_FRAMES = 6;

/**
 * The stock host could not be assembled up to `stage`, so nothing about the
 * plugin under test has run. Thrown in place of the host's own error: the
 * watcher attributes a run by what its reporter prints, and an AssertionError
 * raised by a host row must not read as this plugin's. The host's error is
 * therefore kept where the reporter does not print it; `cause` is printed in
 * full.
 */
export class HostAssemblyError extends Error {
	constructor(stage, hostError) {
		super(`the stock host could not be assembled: ${stage}`);
		this.name = "HostAssemblyError";
		this.code = "DSH_HOST_ASSEMBLY_FAILED";
		this.stage = stage;
		Object.defineProperty(this, "hostError", { value: hostError });
	}
}

/** A fixture HTTP listener outlived its test: the fixture's own defect, never an assertion about the plugin. */
export class FixtureListenerLeakError extends Error {
	constructor(count) {
		super(`${count} fixture HTTP listener(s) outlived their test`);
		this.name = "FixtureListenerLeakError";
		this.code = "DSH_FIXTURE_LISTENER_LEAK";
	}
}

/**
 * Release a composition that is being abandoned. Best effort by design: the
 * failure already being reported must not be replaced, so a dispose that
 * throws or rejects is returned instead of raised.
 */
export async function disposeComposition(ctx) {
	try { await ctx?.fiber?.dispose?.(); }
	catch (error) { return error; }
	return undefined;
}

/**
 * Skip `t` when the stock host itself could not be assembled. Anything else
 * is rethrown: a check that swallows an unexpected error reports nothing.
 */
export function skipIfHostUnassembled(t, error) {
	if (!(error instanceof HostAssemblyError)) throw error;
	const detail = String(error.hostError?.message ?? error.hostError ?? "").split(/\r?\n/, 1)[0].slice(0, 160);
	t.skip(`stock host does not assemble on this runtime (${error.stage}: ${detail})`);
}

/**
 * Announce a host row that failed before the plugin under test was imported.
 * The upstream watcher matches the leading line in
 * scripts/lib/upstream-compat-core.mjs and attributes the run to the host.
 * The host's own frames follow, so a report still says where upstream threw:
 * the test throws a HostAssemblyError in place of the host's error, and the
 * reporter prints only that one. A cleanup that failed is named on its own
 * last line.
 */
export function reportHostAssemblyFailure(stage, error, cleanup) {
	const frames = String(error?.stack ?? "").split(/\r?\n/).filter((line) => /^\s+at /.test(line)).slice(0, HOST_FRAMES);
	console.error([
		`DSH_HOST_ASSEMBLY_FAILED ${stage}: ${describe(error)}`,
		...frames,
		...(cleanup ? [`DSH_FIXTURE_CLEANUP_FAILED ${stage}: ${describe(cleanup)}`] : []),
	].join("\n"));
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
 * then fail on it by name. The failure is the fixture's own, so it is announced
 * on a leading line and thrown as a typed error: an assertion here would be
 * read by the watcher as one of the plugin's.
 */
export async function releaseLeakedFixtureListeners() {
	const leaked = [...listeners].filter((server) => server.listening);
	await Promise.all(leaked.map((server) => new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	})));
	if (leaked.length === 0) return;
	console.error(`DSH_FIXTURE_LISTENER_LEAK ${leaked.length} fixture HTTP listener(s) outlived their test`);
	throw new FixtureListenerLeakError(leaked.length);
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
