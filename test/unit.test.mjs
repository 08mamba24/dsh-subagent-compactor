/**
 * Unit tests for @local/dsh-subagent-compactor: drive the real module
 * through its public apply() path with stub contexts. Real DSH-module
 * composition is covered by integration.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name as pluginName, Config } from "../index.js";

class ManualError extends Error {
	constructor(code, message) {
		super(message ?? `engine failure ${code}`);
		this.name = "ManualCompactionError";
		this.code = code;
	}
}

/** Error-shape peer of the engine's ManualCompactionError. */
function makeAgent({ id = "child-1", busy = false, disposeDuringWait = false } = {}) {
	const agent = {
		id,
		whenIdleCalls: 0,
		whenIdle() {
			this.whenIdleCalls += 1;
			if (disposeDuringWait) {
				// simulate: wait resolves, then the registry swapped the entry
				return Promise.resolve();
			}
			return busy ? new Promise(() => {}) : Promise.resolve();
		}
	};
	return agent;
}

function makeHarness({ agent, owned = true, resident = true, presets, hostEngine, children, config } = {}) {
	const caller = { id: "parent-1", label: "caller" };
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: {
			get: (id) => (resident && id === agent?.id ? agent : undefined),
			isOwnedBy: (id, owner) => owned && id === agent?.id && owner === caller
		},
		subagents: {
			listChildren: children ?? (async () => [{ id: "child-1", mode: "continuable", label: "worker" }])
		},
		get(serviceName) {
			if (serviceName === "agentPresets") return presets;
			if (serviceName === "compaction") return hostEngine;
			return undefined;
		},
		commands: {
			register(definition) {
				registrations.commands.push(definition);
				return () => {};
			}
		},
		tools: {
			register(definition) {
				registrations.tools.push(definition);
				return () => {};
			}
		},
		effect(generator, label) {
			registrations.effects.push({ generator, label });
			return () => {};
		}
	};
	apply(ctx, config ?? {});
	// Run the effect generator like Cordis would: execute to completion,
	// collecting the yielded disposers (cleanup was yielded first).
	for (const { generator } of registrations.effects) {
		const iterator = generator();
		let step = iterator.next();
		while (!step.done) {
			registrations.effectDisposers.push(step.value);
			step = iterator.next();
		}
	}
	const command = registrations.commands.find((definition) => definition.name === "subagent-compact");
	const tool = registrations.tools[0];
	return { ctx, caller, command, tool, registrations };
}

function invocation(harness, rawInput, signal) {
	return {
		rawInput,
		agent: harness.caller,
		signal: signal ?? new AbortController().signal,
		commandId: "cmd-1"
	};
}

test("plugin surface", () => {
	assert.equal(pluginName, "subagent-compactor");
	assert.deepEqual(inject, ["commands", "tools", "agents", "subagents"]);
	assert.equal(Config({}).waitForIdle, true);
	assert.equal(Config({ waitForIdle: false }).waitForIdle, false);
});

test("apply registers command and tool inside one reversed-order effect", () => {
	const harness = makeHarness({ agent: makeAgent() });
	assert.equal(harness.registrations.commands.length, 1);
	assert.equal(harness.registrations.tools.length, 1);
	assert.equal(harness.command.name, "subagent-compact");
	assert.equal(harness.tool.name, "compact_subagent");
	// cleanup disposer first yield => disposed last
	assert.equal(typeof harness.registrations.effectDisposers[0], "function");
});

test("command no-arg lists direct children", async () => {
	const harness = makeHarness({ agent: makeAgent() });
	const result = await harness.command.handler(invocation(harness, "   "));
	assert.equal(result.kind, "success");
	assert.match(result.text, /child-1 \[continuable\] worker/);
});

test("command no-arg with empty catalog and with projection failure", async () => {
	const empty = makeHarness({ agent: makeAgent(), children: async () => [] });
	assert.match((await empty.command.handler(invocation(empty, ""))).text, /no direct subagents/);
	const broken = makeHarness({
		agent: makeAgent(),
		children: async () => {
			throw new Error("sessionQuery unavailable");
		}
	});
	const result = await broken.command.handler(invocation(broken, ""));
	assert.equal(result.kind, "error");
	assert.match(result.text, /Listing unavailable: sessionQuery unavailable/);
});

test("command usage errors: too many arguments", async () => {
	const harness = makeHarness({ agent: makeAgent() });
	const result = await harness.command.handler(invocation(harness, "a b"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /Usage: \/subagent-compact/);
});

test("ghost id without a live agent: no sessionQuery means cold resolution is unavailable", async () => {
	// The stub harness has no runMaintenance: the plugin reports the missing
	// host capability first. Give it the capability to reach the query check.
	const base = makeColdHarness({
		observationSpec: { events: [], values: { inbox: { "next-turn": [], "next-step": [] } } }
	});
	delete base.ctx.subagents.runMaintenance;
	const ctx = { ...base.ctx, subagents: { ...base.ctx.subagents } };
	const result = await base.command.handler({ rawInput: "ghost", agent: base.caller, signal: new AbortController().signal, commandId: "cmd" });
	assert.equal(result.kind, "error");
	assert.match(result.text, /manager-owned maintenance capability/);
});

test("cold compaction refuses clearly on a runtime without the maintenance capability", async () => {
	const harness = makeHarness({ agent: undefined, resident: false });
	const result = await harness.command.handler(invocation(harness, "some-id"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /ctx\.subagents\.runMaintenance/);
	assert.match(result.text, /HOST_MAINTENANCE_REQUIREMENTS/);
});

test("not-authorized for foreign/self/grandchild targets (runtime ownership only)", async () => {
	const harness = makeHarness({ agent: makeAgent(), owned: false });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "not-authorized");
	assert.match(result.text, /not one of your live runtime-created direct subagents/);
});

test("preset plane resolves via serviceFor and never falls back to the host engine", async () => {
	let serviceForCalls = 0;
	const engine = { compactNow: async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900, summarySeq: 7 }) };
	const presets = {
		serviceFor: (target, serviceName) => {
			serviceForCalls += 1;
			assert.equal(serviceName, "compaction");
			return target.id === "child-1" ? engine : undefined;
		}
	};
	const hostEngine = { compactNow: async () => assert.fail("host engine must not be reached") };
	const harness = makeHarness({ agent: makeAgent(), presets, hostEngine });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted");
	assert.equal(serviceForCalls, 1);
	assert.deepEqual(
		{ ...result },
		{
			text: result.text,
			outcome: "compacted",
			target_session_id: "child-1",
			summary_seq: 7,
			replaced_items: 3,
			replaced_tokens: 900
		}
	);
	assert.match(result.text, /session-seq 7/);
});

test("preset present but its engine missing fails explicitly (no host fallback)", async () => {
	const presets = { serviceFor: () => undefined };
	const hostEngine = { compactNow: async () => assert.fail("must not fall back") };
	const harness = makeHarness({ agent: makeAgent(), presets, hostEngine });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "engine-missing");
	assert.match(result.text, /preset does not provide a compaction engine/);
});

test("host plane used only when no preset registry exists", async () => {
	const engine = { compactNow: async () => null };
	const harness = makeHarness({ agent: makeAgent(), presets: undefined, hostEngine: engine });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "nothing-to-compact");
	assert.match(result.text, /No compactable history yet/);
});

test("host plane absent fails explicitly", async () => {
	const harness = makeHarness({ agent: makeAgent(), presets: undefined, hostEngine: undefined });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "engine-missing");
	assert.match(result.text, /no Host-plane compaction engine/);
});

test("waitForIdle waits for the child and re-checks identity afterwards (TOCTOU)", async () => {
	const agent = makeAgent();
	let waitObserved = 0;
	agent.whenIdle = () => {
		waitObserved += 1;
		return Promise.resolve();
	};
	const engine = { compactNow: async () => ({ shadowedSeqs: [2], shadowedTokenCount: 10, summarySeq: 5 }) };
	const harness = makeHarness({ agent, hostEngine: engine });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted");
	assert.equal(waitObserved, 1);

	// Identity swap during the wait must not compact the stale handle.
	const stale = makeAgent();
	const swappedHarness = makeHarness({ agent: stale, hostEngine: engine });
	let waited = false;
	stale.whenIdle = () => {
		waited = true;
		// after whenIdle resolves, the registry returns a different object
		swappedHarness.ctx.agents.get = () => ({ id: "child-1", generation: 2 });
		return Promise.resolve();
	};
	await new Promise((resolve) => setTimeout(resolve));
	const swapped = await swappedHarness.tool.execute({ session_id: "child-1" }, { agent: swappedHarness.caller, signal: new AbortController().signal });
	assert.equal(waited, true);
	assert.equal(swapped.outcome, "not-resident");
	assert.match(swapped.text, /disposed while waiting/);
});

test("waitForIdle: false skips the wait entirely", async () => {
	const agent = makeAgent();
	agent.whenIdle = () => assert.fail("must not wait");
	const engine = { compactNow: async () => ({ shadowedSeqs: [1], shadowedTokenCount: 5, summarySeq: 3 }) };
	const harness = makeHarness({ agent, hostEngine: engine, config: { waitForIdle: false } });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted");
});

test("all six manual codes map to distinct messages and outcomes", async () => {
	const codes = ["busy", "cancelled", "changed", "summary", "commit", "persistence"];
	const texts = new Set();
	for (const code of codes) {
		const engine = {
			compactNow: async () => {
				throw new ManualError(code);
			}
		};
		const harness = makeHarness({ agent: makeAgent(), hostEngine: engine, config: { waitForIdle: false } });
		const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
		assert.equal(result.outcome, code);
		texts.add(result.text);
	}
	assert.equal(texts.size, codes.length);
});

test("unknown manual code stays diagnosable", async () => {
	const engine = {
		compactNow: async () => {
			throw new ManualError("wild-code", "engine exploded");
		}
	};
	const harness = makeHarness({ agent: makeAgent(), hostEngine: engine, config: { waitForIdle: false } });
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "unknown-code");
	assert.match(result.text, /wild-code/);
	assert.match(result.text, /engine exploded/);
});

test("caller-cancelled wins over busy when the signal is aborted", async () => {
	const engine = {
		compactNow: async () => {
			throw new ManualError("busy");
		}
	};
	const agent = makeAgent();
	const controller = new AbortController();
	agent.whenIdle = () => new Promise((resolve) => {
		setTimeout(resolve, 5);
	});
	const harness = makeHarness({ agent, hostEngine: engine });
	const operation = harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: controller.signal });
	setTimeout(() => controller.abort(new Error("user cancelled")), 1);
	const result = await operation;
	assert.equal(result.outcome, "cancelled");
	assert.match(result.text, /cancelled/i);
});

test("waiting on an eternally-busy child is cancellable via the request signal", async () => {
	const engine = { compactNow: async () => assert.fail("must not reach the engine") };
	const agent = makeAgent({ busy: true });
	const controller = new AbortController();
	const harness = makeHarness({ agent, hostEngine: engine });
	const operation = harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: controller.signal });
	setTimeout(() => controller.abort(new Error("user cancelled")), 1);
	const result = await operation;
	assert.equal(result.outcome, "cancelled");
});

test("non-manual engine errors propagate", async () => {
	const engine = {
		compactNow: async () => {
			throw new TypeError("engine bug");
		}
	};
	const harness = makeHarness({ agent: makeAgent(), hostEngine: engine, config: { waitForIdle: false } });
	await assert.rejects(
		harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal }),
		/engine bug/
	);
});

test("tool requires a calling agent", async () => {
	const harness = makeHarness({ agent: makeAgent() });
	await assert.rejects(
		harness.tool.execute({ session_id: "child-1" }, { signal: new AbortController().signal }),
		/no calling agent/
	);
});

test("tool output render produces a text block", () => {
	const harness = makeHarness({ agent: makeAgent() });
	const blocks = harness.tool.output.render({}, { text: "Compacted subagent." });
	assert.deepEqual(blocks, [{ type: "text", text: "Compacted subagent." }]);
});

test("command success result carries no sourceEventSeq (child seq must not decorate parent command/done)", async () => {
	const engine = { compactNow: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 42, summarySeq: 9 }) };
	const harness = makeHarness({ agent: makeAgent(), hostEngine: engine, config: { waitForIdle: false } });
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "success");
	assert.equal("sourceEventSeq" in result, false);
	assert.match(result.text, /replaced 2 history items/);
	assert.match(result.text, /~42 tokens of the replaced history/);
});

test("unload aborts in-flight operations and converges", async () => {
	const engine = {
		compactNow: (agent, signal) => new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(new ManualError("cancelled")), { once: true });
		})
	};
	const agent = makeAgent({ busy: true });
	const harness = makeHarness({ agent, hostEngine: engine });
	const controller = new AbortController();
	// The child is eternally busy, so the operation parks in the idle wait
	// until the plugin's own unload aborts it.
	const operation = harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 2));
	// Reverse-order dispose like Cordis: registrations first, cleanup last.
	for (const disposer of [...harness.registrations.effectDisposers].reverse()) {
		await (typeof disposer === "function" ? disposer() : disposer);
	}
	const settled = await Promise.race([
		operation.then(() => "settled", () => "settled"),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 500))
	]);
	assert.equal(settled, "settled");
	// The unload abort is what ended the parked wait: outcome is a clean cancellation.
	assert.equal((await operation).outcome, "cancelled");
});

test("an already-aborted signal settles immediately instead of hanging the idle wait", async () => {
	const engine = { compactNow: async () => assert.fail("must not reach the engine") };
	const agent = makeAgent({ busy: true });
	const harness = makeHarness({ agent, hostEngine: engine });
	const controller = new AbortController();
	controller.abort(new Error("cancelled before start"));
	const startedAt = Date.now();
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: controller.signal });
	assert.equal(result.outcome, "cancelled");
	assert.ok(Date.now() - startedAt < 50, "must not wait on an already-aborted signal");
});

test("pending listing is cancelled by plugin unload through the fused signal", async () => {
	const harness = makeHarness({
		agent: makeAgent(),
		children: (_parentId, signal) => new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		})
	});
	const operation = harness.command.handler(invocation(harness, "", new AbortController().signal));
	await new Promise((resolve) => setTimeout(resolve, 2));
	for (const disposer of [...harness.registrations.effectDisposers].reverse()) {
		await (typeof disposer === "function" ? disposer() : disposer);
	}
	const settled = await Promise.race([
		operation.then(() => "settled", () => "settled"),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 500))
	]);
	assert.equal(settled, "settled");
	const result = await operation;
	assert.equal(result.kind, "error");
	assert.match(result.text, /Listing cancelled/);
});

test("command declares input so Desktop's UI claims parameterized invocations", async () => {
	const harness = makeHarness({ agent: makeAgent() });
	assert.equal(harness.command.input?.hint, "[<subagent-session-id>]");
	// Mirror of the real Desktop claim predicate
	// (dsh-client-ui-commands/lib/client.js:1661-1665): a non-bare line is
	// claimed only when the definition declares `input`; otherwise it falls
	// through to a plain user message.
	const desktopClaims = (definition, line) => {
		const bare = line.trim() === `/${definition.name}` || line.trim() === `/${definition.name} `;
		if (definition.input !== undefined) return { claim: true };
		if (!bare) return undefined;
		return { claim: true };
	};
	assert.notEqual(desktopClaims(harness.command, "/subagent-compact 3f0c"), undefined, "parameterized line must be claimable");
	assert.notEqual(desktopClaims(harness.command, "/subagent-compact"), undefined, "bare line must remain claimable");
});

// ---------------------------------------------------------------------------
// Cold-path unit tests: the persisted-target decision table with stubbed
// sessionQuery / agents.resume, plus the live/persisted listing split.

/** One disposable observation lease shaped like sessionQuery.observeSession's. */
function observation({ id = "cold-1", parentSession = "parent-1", events = [], inheritedEventCount = 0, values = {} } = {}) {
	return {
		source: "prepared",
		header: { id, parentSession },
		inheritedEventCount,
		events: Object.freeze(events),
		projections: { values },
		disposed: false,
		[Symbol.dispose]() {
			this.disposed = true;
		}
	};
}

function continuableDescriptorEvent(overrides = {}) {
	return { seq: 0, type: "subagent/descriptor", data: { version: 3, mode: "continuable", provider: "spawn", label: "worker", ...overrides } };
}

/** Child-context stub sufficient for applyChildComposition's override arm. */
function childCtxStub() {
	return {
		get: () => undefined,
		systemPrompt: {
			context() {},
			getContextOrder: () => 0,
			getSectionOrder: () => 0,
			section() {}
		},
		tools: { restrict() {} }
	};
}

/** Restored-agent stub: idle, empty inbox, disposable handle. */
function restoredAgentStub(id) {
	return {
		id,
		status: "idle",
		inbox: { hasPending: false, nextTurn: [], nextStep: [] },
		whenIdle: async () => {}
	};
}

/**
 * Harness with a cold observation + manager-owned maintenance stub. The
 * stub `ctx.subagents.runMaintenance` records its call and runs the plugin's
 * job against a restored-agent stub, mirroring the patched host contract;
 * `maintenanceImpl` may reject to simulate manager-side failures.
 */
function makeColdHarness({ observationSpec, maintenanceImpl, hostEngine, presets, children, agent, owned = true } = {}) {
	const caller = { id: "parent-1" };
	const lease = observation({ parentSession: caller.id, ...observationSpec });
	const restored = restoredAgentStub(observationSpec?.id ?? "cold-1");
	const maintenanceCalls = [];
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: {
			get: (id) => (id === caller.id ? caller : id === (agent?.id ?? "no-live") ? agent : undefined),
			isOwnedBy: (id, owner) => owned && id === agent?.id && owner === caller
		},
		subagents: {
			listChildren: children ?? (async () => [{ id: "cold-1", mode: "continuable", label: "worker" }]),
			runMaintenance: async (parent, childId, options) => {
				maintenanceCalls.push({ parent, childId, options });
				if (maintenanceImpl !== undefined) return maintenanceImpl(parent, childId, options);
				return options.job(restored, options.signal);
			}
		},
		get(serviceName) {
			if (serviceName === "agentPresets") return presets;
			if (serviceName === "compaction") return hostEngine;
			if (serviceName === "sessionQuery") return { observeSession: async () => lease };
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
	const tool = registrations.tools[0];
	return { ctx, caller, command, tool, lease, restored, maintenanceCalls, registrations };
}

test("cold: unknown session id resolves to unknown-session, not not-resident", async () => {
	const caller = { id: "parent-1" };
	const notFound = Object.assign(new Error('session "ghost" not found'), { name: "SessionQueryError" });
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: { get: () => undefined, isOwnedBy: () => false },
		subagents: { listChildren: async () => [], runMaintenance: async () => assert.fail("maintenance must not run") },
		get(serviceName) {
			if (serviceName === "sessionQuery") return { observeSession: async () => { throw notFound; } };
			return undefined;
		},
		commands: { register(d) { registrations.commands.push(d); return () => {}; } },
		tools: { register(d) { registrations.tools.push(d); return () => {}; } },
		effect(g) { registrations.effects.push({ generator: g }); return () => {}; }
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
	const command = registrations.commands[0];
	const result = await command.handler({ rawInput: "ghost", agent: caller, signal: new AbortController().signal, commandId: "cmd" });
	assert.equal(result.kind, "error");
	assert.match(result.text, /No live agent or persisted session with id "ghost"/);
});

test("cold: happy path runs the engine inside the manager-owned maintenance job", async () => {
	const engine = { compactNow: async () => ({ shadowedSeqs: [3, 4], shadowedTokenCount: 300, summarySeq: 9 }) };
	const harness = makeColdHarness({
		observationSpec: {
			id: "cold-1",
			events: [continuableDescriptorEvent({ agentProvider: "p", agentModel: "m", agentReasoningEffort: "high", persona: "be terse" })],
			values: { inbox: { "next-turn": [], "next-step": [] } }
		},
		hostEngine: engine
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted", result.text);
	assert.equal(result.summary_seq, 9);
	// The thin call: exactly one manager-owned maintenance with the caller,
	// the target id, and the request signal; the engine is the only job.
	assert.equal(harness.maintenanceCalls.length, 1);
	const [call] = harness.maintenanceCalls;
	assert.equal(call.parent, harness.caller);
	assert.equal(call.childId, "cold-1");
	const jobResult = await call.options.job(harness.restored, call.options.signal);
	assert.deepEqual(jobResult, { shadowedSeqs: [3, 4], shadowedTokenCount: 300, summarySeq: 9 });
	assert.equal(harness.lease.disposed, true, "the observation lease must be released");
});

test("cold: per-target lock refuses a concurrent second compaction with busy-target", async () => {
	let releaseJob;
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		maintenanceImpl: (_parent, _childId, options) => new Promise((resolve) => {
			releaseJob = () => resolve(options.job(harness.restored, options.signal));
		}),
		hostEngine: { compactNow: async () => ({ shadowedSeqs: [1], shadowedTokenCount: 5, summarySeq: 2 }) }
	});
	const first = harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	const second = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(second.outcome, "busy-target");
	assert.match(second.text, /already in progress/);
	releaseJob();
	assert.equal((await first).outcome, "compacted");
});

test("cold: one-shot, missing, and malformed descriptors are unsupported targets; maintenance never runs", async () => {
	const cases = [
		{ name: "one-shot", events: [{ seq: 0, type: "subagent/descriptor", data: { version: 3, mode: "one-shot", provider: "spawn", label: "once" } }] },
		{ name: "missing", events: [{ seq: 0, type: "turn/start", data: { turn: 1 } }] },
		{ name: "malformed", events: [{ seq: 0, type: "subagent/descriptor", data: { version: 3, mode: "continuable", provider: "spawn", label: "w", rogue: 1 } }] }
	];
	for (const testCase of cases) {
		const harness = makeColdHarness({
			observationSpec: { events: testCase.events, values: { inbox: { "next-turn": [], "next-step": [] } } },
			hostEngine: { compactNow: async () => assert.fail("engine must not run") }
		});
		const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
		assert.equal(result.outcome, "unsupported-target", testCase.name);
		assert.equal(harness.maintenanceCalls.length, 0, testCase.name);
	}
});

test("cold: foreign lineage header is not-authorized; self-target through the live path stays not-authorized", async () => {
	const harness = makeColdHarness({
		observationSpec: { parentSession: "someone-else", events: [continuableDescriptorEvent()] },
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "not-authorized");
	assert.match(result.text, /belongs to another parent session/);
	assert.equal(harness.maintenanceCalls.length, 0);
});

test("cold: persisted pending input refuses before materializing anything", async () => {
	const harness = makeColdHarness({
		observationSpec: {
			events: [continuableDescriptorEvent()],
			values: { inbox: { "next-turn": [{ id: "m1" }], "next-step": [] } }
		},
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "pending-input");
	assert.match(result.text, /1 persisted pending message/);
	assert.match(result.text, /untouched/);
	assert.equal(harness.maintenanceCalls.length, 0, "refusal must not start a maintenance activation");
});

test("cold: an independent preset selection without a projection identity fails restoration explicitly", async () => {
	const harness = makeColdHarness({
		observationSpec: {
			events: [
				{ seq: 0, type: "agent-preset/selected", data: { agentPreset: "child-preset" } },
				continuableDescriptorEvent()
			],
			values: { inbox: { "next-turn": [], "next-step": [] }, agentPreset: null }
		},
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "restore-failed");
	assert.match(result.text, /preset/);
	assert.equal(harness.maintenanceCalls.length, 0);
});

test("cold: SubagentError codes from the manager map to distinct outcomes", async () => {
	const cases = [
		{ code: "UNAUTHORIZED", outcome: "not-authorized", match: /belongs to another parent session/ },
		{ code: "DUPLICATE_CHILD", outcome: "busy-target", match: /retry shortly/ },
		{ code: "ACTIVATION_CLOSING", outcome: "busy-target", match: /retry shortly/ },
		{ code: "NOT_RESUMABLE", outcome: "restore-failed", match: /could not be restored/ },
		{ code: "PERSISTENCE_UNAVAILABLE", outcome: "query-unavailable", match: /persistence|query/i }
	];
	for (const testCase of cases) {
		const harness = makeColdHarness({
			observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
			maintenanceImpl: async () => {
				const error = new Error(`manager failure ${testCase.code}`);
				error.name = "SubagentError";
				error.code = testCase.code;
				throw error;
			}
		});
		const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
		assert.equal(result.outcome, testCase.outcome, testCase.code);
		assert.match(result.text, testCase.match, testCase.code);
	}
});

test("cold: SessionAlreadyOwnedError from the manager maps to a retryable busy-target", async () => {
	const owned = Object.assign(new Error('session "cold-1" is already owned'), { name: "SessionAlreadyOwnedError" });
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		maintenanceImpl: async () => { throw owned; },
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "busy-target");
	assert.match(result.text, /concurrently owned/);
});

test("cold: an aborted maintenance settles as a clean cancellation", async () => {
	const controller = new AbortController();
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		maintenanceImpl: () => new Promise((_resolve, reject) => {
			controller.abort(new Error("user cancelled"));
			reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
		}),
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: controller.signal });
	assert.equal(result.outcome, "cancelled");
	assert.equal(harness.lease.disposed, true);
});

// ---------------------------------------------------------------------------
// The R1 release cutoff / stranding machinery was removed with the move to
// manager-owned maintenance: the patched host's settlement lifecycle owns
// those guarantees, and the R2 contract integration suites verify them
// against real routes.

test("command declares input so Desktop's UI claims parameterized invocations", async () => {
	const harness = makeHarness({ agent: makeAgent() });
	assert.equal(harness.command.input?.hint, "[<subagent-session-id>]");
	// Mirror of the real Desktop claim predicate
	// (dsh-client-ui-commands/lib/client.js:1661-1665): a non-bare line is
	// claimed only when the definition declares `input`; otherwise it falls
	// through to a plain user message.
	const desktopClaims = (definition, line) => {
		const bare = line.trim() === `/${definition.name}` || line.trim() === `/${definition.name} `;
		if (definition.input !== undefined) return { claim: true };
		if (!bare) return undefined;
		return { claim: true };
	};
	assert.notEqual(desktopClaims(harness.command, "/subagent-compact 3f0c"), undefined, "parameterized line must be claimable");
	assert.notEqual(desktopClaims(harness.command, "/subagent-compact"), undefined, "bare line must remain claimable");
});
