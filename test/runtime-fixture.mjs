/** Test-only adaptation of activation specs; no runtime service is patched. */
const names = new WeakMap();
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
