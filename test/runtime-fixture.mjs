/** Test-only adaptation of activation specs; no runtime service is patched. */
const names = new WeakMap();

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
