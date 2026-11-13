import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";

/** rc.2-shaped context: catalogs give creator edges; rootOf gives live ownership. */
function runtime({ resident = true, entries = [{ id: "child", mode: "continuable" }], observe, startInfo = {} } = {}) {
	const caller = { id: "parent" }, otherRoot = { id: "other" };
	const child = { id: "child", whenIdle: async () => {} };
	const agents = new Map([[caller.id, caller], [otherRoot.id, otherRoot]]);
	if (resident) agents.set(child.id, child);
	const roots = new Map([[caller, caller], [otherRoot, otherRoot], [child, caller]]);
	const calls = { reads: 0, disposed: 0, compact: 0, send: 0, accepted: 0 };
	const listeners = new Set(), disposers = [];
	let command, tool;
	const emit = (type, info) => { for (const x of [...listeners]) if (x.type === type) x.fn(info); };
	const query = { async observeSession(id, options) {
		calls.reads++;
		if (observe) return observe(id, options);
		return { projections: { values: { subagentCatalog: entries } }, [Symbol.dispose]() { calls.disposed++; } };
	} };
	const ctx = {
		agents: { get: (id) => agents.get(id) },
		subagents: {
			rootOf(agent) {
				if (agents.get(agent.id) !== agent || !roots.has(agent)) throw Object.assign(new Error("no runtime owner"), { name: "SubagentError", code: "UNAUTHORIZED" });
				return roots.get(agent);
			},
			async sendMessage(_sender, id, _content, { signal }) {
				calls.send++;
				agents.set(id, child);
				emit("subagent/start", { id, parentSessionId: caller.id, runId: "run-1", local: true, provider: "spawn", ...startInfo });
				signal.throwIfAborted();
				calls.accepted++;
				return "wake-1";
			}
		},
		get(name) {
			if (name === "sessionQuery") return query;
			if (name === "compaction") return { compactNow() { calls.compact++; return Promise.resolve({ shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 3 }); } };
		},
		on(type, fn) { const x = { type, fn }; listeners.add(x); return () => listeners.delete(x); },
		commands: { register(x) { command = x; return () => {}; } },
		tools: { register(x) { tool = x; return () => {}; } },
		effect(factory) { for (const dispose of factory()) disposers.push(dispose); }
	};
	apply(ctx);
	return { ctx, caller, child, agents, roots, otherRoot, calls, listeners, emit,
		invoke: (input, signal = new AbortController().signal) => command.handler({ agent: caller, rawInput: input, signal, commandId: "cmd-authorization" }),
		runTool: (id = "child", agent = caller, signal = new AbortController().signal) => tool.execute({ session_id: id }, { agent, signal }),
		unload: async () => { for (const dispose of [...disposers].reverse()) await dispose(); }
	};
}

test("rc2: direct projection serves listing/batch and is always released", async () => {
	const h = runtime();
	assert.equal((await h.invoke("")).kind, "success");
	const batch = await h.invoke("all");
	assert.equal(batch.kind, "success", batch.text);
	assert.equal(h.calls.compact, 1);
	assert.equal(h.calls.reads, 2, "one read per listing or batch snapshot");
	assert.equal(h.calls.disposed, 2);
});

for (const resident of [true, false]) test(`rc2: shared root does not authorize a non-direct target (resident=${resident})`, async () => {
	const h = runtime({ resident, entries: [] });
	const result = await h.runTool();
	assert.equal(result.outcome, "not-authorized");
	assert.equal(h.calls.send, 0);
	assert.equal(h.calls.compact, 0);
});

test("rc2: a lookalike caller with the same id is refused", async () => {
	const h = runtime({ resident: false });
	assert.equal((await h.runTool("child", { id: h.caller.id })).outcome, "not-authorized");
	assert.equal(h.calls.reads, 0);
	assert.equal(h.calls.send, 0);
});

test("rc2: catalog membership does not authorize an unmanaged or foreign live instance", async () => {
	for (const root of [undefined, "other"]) {
		const h = runtime();
		if (root === undefined) h.roots.delete(h.child); else h.roots.set(h.child, h.otherRoot);
		assert.equal((await h.runTool()).outcome, "not-authorized");
		assert.equal(h.calls.compact, 0);
	}
});

test("rc2: missing or malformed projection fails honestly and releases observation", async () => {
	for (const entries of [undefined, [{ kind: "diagnostic", id: "child", reason: "corrupt" }]]) {
		let disposed = 0;
		const h = runtime({ observe: async () => ({ projections: { values: { subagentCatalog: entries } }, [Symbol.dispose]() { disposed++; } }) });
		const result = await h.invoke("all");
		assert.equal(result.kind, "error");
		assert.match(result.text, /catalog|projection/i);
		assert.equal(disposed, 1);
		assert.equal(h.calls.compact, 0);
		assert.equal(h.calls.send, 0);
	}
});

test("rc2: observation cancellation/unload reaches the read and never sends a wake", async () => {
	const entered = Promise.withResolvers();
	const h = runtime({ resident: false, observe: (_id, { signal }) => new Promise((_, reject) => {
		entered.resolve(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	}) });
	const operation = h.runTool();
	await entered.promise; await h.unload();
	assert.equal((await operation).outcome, "cancelled");
	assert.equal(h.calls.send, 0);
});

for (const startInfo of [{ parentSessionId: "different-parent" }, { runId: undefined }, { local: false }]) {
	test(`rc2: an invalid start edge cannot accept a wake (${JSON.stringify(startInfo)})`, async () => {
		const h = runtime({ resident: false, startInfo });
		const result = await h.runTool();
		assert.equal(result.outcome, "not-authorized", result.text);
		assert.equal(h.calls.accepted, 0);
		assert.equal(h.calls.compact, 0);
		assert.equal(h.listeners.size, 0);
	});
}

test("rc2: valid resume reserves maintenance synchronously before accepting its wake", async () => {
	const h = runtime({ resident: false });
	const send = h.ctx.subagents.sendMessage;
	h.ctx.subagents.sendMessage = async (...args) => {
		const delivery = send(...args);
		assert.equal(h.calls.compact, 1, "start listener must not await another catalog read or idle wait");
		return delivery;
	};
	const result = await h.runTool();
	assert.equal(result.outcome, "compacted", result.text);
	assert.equal(result.resumed, true);
	assert.equal(h.calls.accepted, 1);
	assert.equal(h.calls.disposed, 1);
});

test("rc2: caller/root identity is rechecked after the live idle wait", async () => {
	for (const replaceCaller of [true, false]) {
		const h = runtime();
		h.child.whenIdle = async () => {
			if (replaceCaller) h.agents.set(h.caller.id, { id: h.caller.id });
			else h.roots.set(h.child, h.otherRoot);
		};
		assert.equal((await h.runTool()).outcome, "not-authorized");
		assert.equal(h.calls.compact, 0);
	}
});

test("rc2: capacity hints cannot authorize a replaced caller or send a late wake", async () => {
	const h = runtime({ resident: false }), denied = Promise.withResolvers();
	h.ctx.subagents.sendMessage = async () => {
		h.calls.send++; denied.resolve();
		throw Object.assign(new Error("full"), { name: "SubagentError", code: "ACTIVATION_LIMIT_REACHED" });
	};
	const operation = h.runTool(); await denied.promise;
	h.agents.set(h.caller.id, { id: h.caller.id });
	h.emit("subagent/end", { id: "unrelated-shared-pool-member" });
	const result = await operation;
	assert.equal(result.outcome, "not-authorized");
	assert.equal(h.calls.send, 1);
	assert.equal(h.calls.accepted, 0);
	assert.equal(h.listeners.size, 0);
	assert.equal((await h.runTool()).outcome, "not-authorized", "target lock was released");
});

test("rc2: an external start cancels only our pending send and uses the live idle path", async () => {
	const h = runtime({ resident: false }), entered = Promise.withResolvers(), idle = Promise.withResolvers();
	h.child.whenIdle = () => idle.promise;
	const controller = new AbortController();
	h.ctx.subagents.sendMessage = (_sender, _id, _content, { signal }) => new Promise((_, reject) => {
		h.calls.send++; entered.resolve();
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	const operation = h.runTool("child", h.caller, controller.signal); await entered.promise;
	h.agents.set(h.child.id, h.child);
	h.emit("subagent/start", { id: h.child.id, parentSessionId: h.caller.id, runId: "external-run", local: true });
	await new Promise(setImmediate);
	assert.equal(controller.signal.aborted, false);
	assert.equal(h.calls.compact, 0);
	idle.resolve();
	assert.equal((await operation).outcome, "compacted");
	assert.equal(h.calls.accepted, 0);
	assert.equal(h.listeners.size, 0);
});
