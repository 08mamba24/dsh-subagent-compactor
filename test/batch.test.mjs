/**
 * Unit tests for the live-only batch surface of @local/dsh-subagent-compactor
 * (`/subagent-compact all`): drive the real module through apply() with stub
 * contexts shaped for multiple children. Real DSH-module composition stays in
 * integration.test.mjs / preset-integration.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";

class ManualError extends Error {
	constructor(code, message) {
		super(message ?? `engine failure ${code}`);
		this.name = "ManualCompactionError";
		this.code = code;
	}
}

/**
 * Multi-child harness. `children` is the durable catalog snapshot; `live` maps
 * session id -> child stub; `owned` is the set of ids the caller owns;
 * `engineFor` returns a per-child engine (default: one clean compaction).
 */
function makeBatchHarness({ children, live = new Map(), owned, engineFor } = {}) {
	const caller = { id: "parent-1", label: "caller" };
	const ownedIds = owned ?? new Set([...live.keys()]);
	const compactCalls = [];
	const defaultEngine = {
		async compactNow(agent, signal, sourceCommandId) {
			compactCalls.push({ id: agent.id, sourceCommandId });
			return { summarySeq: 15, shadowedSeqs: [3, 4], shadowedTokenCount: 900 };
		}
	};
	const engines = new Map();
	const engine = (id) => engineFor?.(id) ?? engines.get(id) ?? defaultEngine;
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: {
			get: (id) => live.get(id),
			isOwnedBy: (id, owner) => owner === caller && ownedIds.has(id)
		},
		subagents: {
			listChildren: children ?? (async () => [])
		},
		get(serviceName) {
			if (serviceName === "compaction") return { serviceFor: undefined, compactNow: undefined, __shared: true };
			return undefined;
		},
		commands: { register(definition) { registrations.commands.push(definition); return () => {}; } },
		tools: { register(definition) { registrations.tools.push(definition); return () => {}; } },
		effect(generator, label) { registrations.effects.push({ generator, label }); return () => {}; }
	};
	apply(ctx, {});
	for (const { generator } of registrations.effects) {
		const iterator = generator();
		let step = iterator.next();
		while (!step.done) {
			registrations.effectDisposers.push(step.value);
			step = iterator.next();
		}
	}
	const command = registrations.commands.find((definition) => definition.name === "subagent-compact");
	const invoke = (rawInput, signal) => command.handler({ rawInput, agent: caller, signal: signal ?? new AbortController().signal, commandId: "cmd-batch" });
	return { ctx, caller, command, invoke, compactCalls, engine, engines, registrations };
}

/** A child stub whose idle wait resolves immediately by default. */
function makeChild(id, { idle = () => Promise.resolve(), onCompact } = {}) {
	const agent = { id, whenIdleCalls: 0, whenIdle() { this.whenIdleCalls += 1; return idle(); } };
	if (onCompact !== undefined) agent.__onCompact = onCompact;
	return agent;
}

/** Mount per-child host-plane engines (no preset registry in this harness). */
function withEngines(harness, spec) {
	harness.ctx.get = (serviceName) => {
		if (serviceName === "compaction") {
			return {
				async compactNow(agent, signal, sourceCommandId) {
					harness.compactCalls.push({ id: agent.id, sourceCommandId });
					const behavior = spec[agent.id] ?? { compact: { summarySeq: 15, shadowedSeqs: [3, 4], shadowedTokenCount: 900 } };
					if (behavior.throwRaw !== undefined) throw behavior.throwRaw;
					if (behavior.fail !== undefined) throw new ManualError(behavior.fail);
					return behavior.compact ?? null;
				}
			};
		}
		return undefined;
	};
	return harness;
}

test("batch on an empty catalog reports empty-catalog as success", async () => {
	const harness = makeBatchHarness({ children: async () => [] });
	const result = await harness.invoke("all");
	assert.equal(result.kind, "success");
	assert.match(result.text, /no direct subagents/);
	assert.equal(harness.compactCalls.length, 0);
});

test("batch compacts every live child concurrently and reports completed", async () => {
	const children = [
		{ id: "child-a", mode: "continuable", label: "worker" },
		{ id: "child-b", mode: "local", label: "probe" }
	];
	const live = new Map([
		/* child-b's idle wait resolves a tick later than child-a's. Note this
		 * stub never reclaims a settled child, so a SERIAL implementation
		 * would also pass this case — the missed-window defect is only
		 * observable against real settlement. What this case pins is the
		 * behavioral surface (both idle waits parked, catalog-order lines,
		 * completed receipt); the concurrency that closes the live window is
		 * proven by the three preset interleavings. */
		["child-a", makeChild("child-a")],
		["child-b", makeChild("child-b", { idle: () => new Promise((resolve) => setTimeout(resolve, 25)) })]
	]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Summary \(completed\)/);
	assert.match(result.text, /child-a: compacted — replaced 2 items/);
	assert.match(result.text, /child-b: compacted — replaced 2 items/);
	/* Both idle waits are parked before either turn ends (concurrency). */
	assert.equal(live.get("child-a").whenIdleCalls, 1);
	assert.equal(live.get("child-b").whenIdleCalls, 1);
	assert.deepEqual(harness.compactCalls.map((call) => call.id).sort(), ["child-a", "child-b"]);
	assert.match(result.text, /child-a: compacted[\s\S]*child-b: compacted/, "report lines keep the catalog order");
	/* Compacted children stay resident and reusable: same agent object, still owned. */
	assert.equal(harness.ctx.agents.get("child-a"), live.get("child-a"));
	assert.equal(harness.ctx.agents.isOwnedBy("child-a", harness.caller), true);
});

test("an item's engine failure does not hide the rest (partial-failure)", async () => {
	const children = [
		{ id: "child-a", mode: "continuable" },
		{ id: "child-b", mode: "continuable" }
	];
	const live = new Map([["child-a", makeChild("child-a")], ["child-b", makeChild("child-b")]]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {
		"child-a": { fail: "persistence" }
	});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Summary \(partial-failure\)/);
	assert.match(result.text, /child-a: persistence — /);
	assert.match(result.text, /child-b: compacted/);
	assert.equal(harness.compactCalls.length, 2);
});

test("a settled (not-resident) child is an expected skip, not a failure", async () => {
	const children = [
		{ id: "child-gone", mode: "continuable", label: "settled" },
		{ id: "child-live", mode: "continuable" }
	];
	const live = new Map([["child-live", makeChild("child-live")]]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Summary \(completed\)/);
	assert.match(result.text, /child-gone: skipped — no longer live/);
	assert.match(result.text, /child-live: compacted/);
	assert.equal(harness.compactCalls.length, 1);
});

test("a child disposed while waiting for idle is also skipped", async () => {
	const children = [{ id: "child-race", mode: "continuable" }];
	const live = new Map([
		["child-race", makeChild("child-race", {
			idle: () => {
				/* The settlement watcher reclaims the child during the idle wait. */
				live.delete("child-race");
				return Promise.resolve();
			}
		})]
	]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "success");
	assert.match(result.text, /child-race: skipped — no longer live/);
	assert.equal(harness.compactCalls.length, 0);
});

test("ownership violations count as failed items without stopping the batch", async () => {
	const children = [
		{ id: "child-foreign", mode: "continuable" },
		{ id: "child-own", mode: "continuable" }
	];
	const live = new Map([["child-foreign", makeChild("child-foreign")], ["child-own", makeChild("child-own")]]);
	const harness = withEngines(makeBatchHarness({
		children: async () => children,
		live,
		owned: new Set(["child-own"])
	}), {});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Summary \(partial-failure\)/);
	assert.match(result.text, /child-foreign: not-authorized/);
	assert.match(result.text, /child-own: compacted/);
	assert.equal(harness.compactCalls.length, 1);
});

test("duplicate catalog ids are compacted exactly once", async () => {
	const children = [
		{ id: "child-a", mode: "continuable" },
		{ id: "child-a", mode: "continuable" }
	];
	const live = new Map([["child-a", makeChild("child-a")]]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const result = await harness.invoke("all");
	assert.match(result.text, /Summary \(completed\) — total 1/);
	assert.equal(harness.compactCalls.length, 1);
});

test("a concurrent single invocation on the same target reports busy-target", async () => {
	const children = [{ id: "child-a", mode: "continuable" }, { id: "child-b", mode: "continuable" }];
	let releaseIdle;
	const live = new Map([
		["child-a", makeChild("child-a", { idle: () => new Promise((resolve) => { releaseIdle = resolve; }) })],
		["child-b", makeChild("child-b")]
	]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const batch = harness.invoke("all");
	/* Give the batch enough ticks to enter child-a's idle wait. */
	await new Promise((resolve) => setImmediate(resolve));
	const single = await harness.invoke("child-a");
	assert.equal(single.kind, "error");
	assert.match(single.text, /already in progress/);
	releaseIdle();
	const result = await batch;
	assert.match(result.text, /child-a: compacted/);
	assert.match(result.text, /child-b: compacted/);
});

test("abort during the run reports every started child cancelled", async () => {
	const children = [
		{ id: "child-a", mode: "continuable" },
		{ id: "child-b", mode: "continuable" }
	];
	const controller = new AbortController();
	const live = new Map([
		["child-a", makeChild("child-a", {
			idle: () => {
				controller.abort();
				return Promise.resolve();
			}
		})],
		["child-b", makeChild("child-b")]
	]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {});
	const result = await harness.invoke("all", controller.signal);
	assert.equal(result.kind, "error");
	assert.match(result.text, /Summary \(batch-cancelled\)/);
	/* Concurrent fan-out: both children were already started, so each
	 * reports its own cancellation — none is silently not-started. */
	assert.match(result.text, /child-a: cancelled/);
	assert.match(result.text, /child-b: cancelled/);
	assert.equal(harness.compactCalls.length, 0);
});

test("an item's unexpected non-manual error does not stop the rest", async () => {
	const children = [
		{ id: "child-a", mode: "continuable" },
		{ id: "child-b", mode: "continuable" }
	];
	const live = new Map([["child-a", makeChild("child-a")], ["child-b", makeChild("child-b")]]);
	const harness = withEngines(makeBatchHarness({ children: async () => children, live }), {
		"child-a": { throwRaw: new TypeError("engine exploded") }
	});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Summary \(partial-failure\)/);
	assert.match(result.text, /child-a: error — unexpected error: engine exploded/);
	assert.match(result.text, /child-b: compacted/);
});

test("a failing catalog read reports listing-failed", async () => {
	const harness = makeBatchHarness({
		children: async () => {
			throw new Error("catalog exploded");
		}
	});
	const result = await harness.invoke("all");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Batch catalog unavailable: catalog exploded/);
});

test("abort while the catalog read is in flight reports an unknown snapshot", async () => {
	const controller = new AbortController();
	const harness = makeBatchHarness({
		/* The real host read honors its signal; mirror that by rejecting on abort.
		 * An already-aborted signal never re-fires, so check it directly too. */
		children: (_parentId, signal) => new Promise((_, reject) => {
			controller.abort();
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		})
	});
	const result = await harness.invoke("all", controller.signal);
	assert.equal(result.kind, "error");
	assert.match(result.text, /cancelled while the catalog read was still in flight/);
});

test("a catalog that resolved past an abort reports its targets not-started", async () => {
	const children = [{ id: "child-a", mode: "continuable" }];
	const controller = new AbortController();
	const harness = makeBatchHarness({
		children: async () => {
			controller.abort();
			return children;
		}
	});
	const result = await harness.invoke("all", controller.signal);
	assert.match(result.text, /child-a: not-started/);
	assert.match(result.text, /Summary \(batch-cancelled\)/);
});

test("--all is an accepted alias; extra arguments are a usage error", async () => {
	const harness = makeBatchHarness({ children: async () => [] });
	assert.match((await harness.invoke("--all")).text, /no direct subagents/);
	const extra = await harness.invoke("all now");
	assert.equal(extra.kind, "error");
	assert.match(extra.text, /Usage: \/subagent-compact \[all \| <subagent-session-id>\]/);
});

test("listing marks live versus persisted children", async () => {
	const children = [
		{ id: "child-live", mode: "continuable", label: "worker" },
		{ id: "child-gone", mode: "continuable" }
	];
	const live = new Map([["child-live", makeChild("child-live")]]);
	const harness = makeBatchHarness({ children: async () => children, live });
	const result = await harness.invoke("");
	assert.match(result.text, /child-live \[continuable\] worker — live/);
	assert.match(result.text, /child-gone \[continuable\] — persisted \(not loaded\)/);
});
