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
	const harness = makeHarness({ agent: undefined, resident: false });
	const result = await harness.command.handler(invocation(harness, "ghost"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /no sessionQuery service to load persisted sessions/);
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
 * Harness with a cold observation + resume stub. `observationSpec` seeds the
 * sessionQuery lease; `resumeImpl` may reject. The host engine compacts.
 */
function makeColdHarness({ observationSpec, resumeImpl, hostEngine, presets, children, agent, owned = true } = {}) {
	const caller = { id: "parent-1" };
	const lease = observation({ parentSession: caller.id, ...observationSpec });
	const resumed = { agent: restoredAgentStub(observationSpec?.id ?? "cold-1"), disposed: false, dispose: async function () { this.disposed = true; } };
	const resumeCalls = [];
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: {
			get: (id) => (id === caller.id ? caller : id === (agent?.id ?? "no-live") ? agent : undefined),
			isOwnedBy: (id, owner) => owned && id === agent?.id && owner === caller,
			resume: async (options) => {
				resumeCalls.push(options);
				if (resumeImpl !== undefined) return resumeImpl(options);
				return resumed;
			}
		},
		subagents: { listChildren: children ?? (async () => [{ id: "cold-1", mode: "continuable", label: "worker" }]) },
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
	return { ctx, caller, command, tool, lease, resumed, resumeCalls, registrations };
}

test("cold: unknown session id resolves to unknown-session, not not-resident", async () => {
	const caller = { id: "parent-1" };
	const notFound = Object.assign(new Error('session "ghost" not found'), { name: "SessionQueryError" });
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [] };
	const ctx = {
		agents: { get: () => undefined, isOwnedBy: () => false },
		subagents: { listChildren: async () => [] },
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

test("cold: happy path restores through agents.resume with the descriptor's composition and releases", async () => {
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
	assert.equal(harness.resumeCalls.length, 1);
	const options = harness.resumeCalls[0];
	assert.equal(options.resumeSessionId, "cold-1");
	assert.equal(options.parentAgent, harness.caller);
	assert.deepEqual(options.agentOptions, { provider: "p", model: "m", reasoningEffort: "high" });
	assert.equal(typeof options.setup, "function");
	// The setup wrapper returns void (no preset mount receipt as commit object).
	const setupResult = await options.setup(childCtxStub(), harness.resumed.agent);
	assert.equal(setupResult, undefined);
	assert.equal(harness.resumed.disposed, true, "the restored handle must be released");
	assert.equal(harness.lease.disposed, true, "the observation lease must be released");
});

test("cold: per-target lock refuses a concurrent second compaction with busy-target", async () => {
	let releaseEngine;
	const engine = { compactNow: () => new Promise((resolve) => { releaseEngine = resolve; }) };
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		hostEngine: engine
	});
	const first = harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	const second = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(second.outcome, "busy-target");
	assert.match(second.text, /already in progress/);
	releaseEngine?.({ shadowedSeqs: [1], shadowedTokenCount: 5, summarySeq: 2 });
	assert.equal((await first).outcome, "compacted");
});

test("cold: one-shot, missing, and malformed descriptors are unsupported targets; resume never runs", async () => {
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
		assert.equal(harness.resumeCalls.length, 0, testCase.name);
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
	assert.equal(harness.resumeCalls.length, 0);
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
	assert.equal(harness.resumeCalls.length, 0, "refusal must not open the writer");
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
	assert.equal(harness.resumeCalls.length, 0);
});

test("cold: an independent preset selection restores through applyChildComposition's preset mount", async () => {
	const engine = { compactNow: async () => ({ shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 4 }) };
	const mounts = [];
	const presets = {
		serviceFor: () => engine,
		mount: async (ctx, id) => { mounts.push(id); return { id }; },
		composeFrom: () => { throw new Error("independent selection must not inherit"); }
	};
	const harness = makeColdHarness({
		observationSpec: {
			events: [
				{ seq: 0, type: "agent-preset/selected", data: { agentPreset: "child-preset" } },
				continuableDescriptorEvent()
			],
			values: { inbox: { "next-turn": [], "next-step": [] }, agentPreset: "child-preset" }
		},
		presets
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted", result.text);
	const options = harness.resumeCalls[0];
	// Run the setup with a child context that exposes the stub registry:
	// applyChildComposition must mount the preset, then apply overrides.
	const childCtx = { ...childCtxStub(), get: (name) => name === "agentPresets" ? presets : undefined };
	await options.setup(childCtx, harness.resumed.agent);
	assert.deepEqual(mounts, ["child-preset"]);
	assert.equal(harness.resumed.disposed, true);
});

test("cold: SessionAlreadyOwnedError from resume maps to a retryable busy-target", async () => {
	const owned = Object.assign(new Error('session "cold-1" is already owned'), { name: "SessionAlreadyOwnedError" });
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		resumeImpl: async () => { throw owned; },
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "busy-target");
	assert.match(result.text, /concurrently owned/);
});

test("cold: a failed release after a committed compaction demotes to release-failed", async () => {
	const engine = { compactNow: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 20, summarySeq: 6 }) };
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		hostEngine: engine
	});
	harness.resumed.dispose = async () => { throw new Error("drain wedged"); };
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "release-failed");
	assert.match(result.text, /Compacted subagent "cold-1"/);
	assert.match(result.text, /could not be released cleanly: drain wedged/);
	assert.equal(result.replaced_items, 2, "stats survive the demotion");
});

test("cold: an aborted restore is a clean cancellation, and the observation lease is released", async () => {
	const controller = new AbortController();
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		resumeImpl: () => new Promise((_resolve, reject) => {
			controller.abort(new Error("user cancelled"));
			reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
		}),
		hostEngine: { compactNow: async () => assert.fail("engine must not run") }
	});
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: controller.signal });
	assert.equal(result.outcome, "cancelled");
	assert.equal(harness.lease.disposed, true);
});

test("listing distinguishes live children from persisted-only records", async () => {
	const agent = { id: "live-child", whenIdle: async () => {} };
	const harness = makeHarness({
		agent,
		owned: true,
		children: async () => [
			{ id: "live-child", mode: "continuable", label: "runner" },
			{ id: "cold-child", mode: "continuable", label: "finished" },
			{ id: "once-child", mode: "one-shot" }
		]
	});
	const result = await harness.command.handler(invocation(harness, ""));
	assert.equal(result.kind, "success");
	assert.match(result.text, /live-child \[continuable\] runner — live/);
	assert.match(result.text, /cold-child \[continuable\] finished — persisted \(not loaded\)/);
	assert.match(result.text, /once-child \[one-shot\] — persisted \(not loaded\)/);
	assert.match(result.text, /observed at listing time/);
});

// ---------------------------------------------------------------------------
// R1 unit tests: the release cutoff (drain) and the stranding path.

/** Minimal agent-scope event emitter for the drain loop's stub agents. */
function agentScopeStub() {
	const listeners = new Map();
	return {
		listeners,
		on(name, callback) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(callback);
			return () => listeners.get(name)?.delete(callback);
		},
		emit(name) {
			for (const callback of [...listeners.get(name) ?? []]) callback();
		}
	};
}

function drainAgentStub(id, { pending = false } = {}) {
	return {
		id,
		status: "idle",
		ctx: agentScopeStub(),
		pendingFlag: pending,
		inbox: {
			get hasPending() { return this.agent.pendingFlag; },
			nextTurn: pending ? [{ id: "parked" }] : [],
			nextStep: [],
			agent: undefined
		},
		whenIdle: async () => {}
	};
}

test("cold R1: release waits for accepted input to drain, then disposes", async () => {
	const agent = drainAgentStub("cold-1");
	agent.inbox.agent = agent;
	// The sentinel is accepted WHILE the engine runs (mid-summary followup).
	const engine = { compactNow: async () => {
		agent.pendingFlag = true;
		return { shadowedSeqs: [1], shadowedTokenCount: 5, summarySeq: 3 };
	} };
	let disposed = false;
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		hostEngine: engine
	});
	harness.resumed.agent = agent;
	harness.resumed.dispose = async () => { disposed = true; };
	const operation = harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	await new Promise((resolve) => setTimeout(resolve, 10));
	// Compaction finished, but the sentinel accepted into the inbox parks the
	// release until it is processed.
	assert.equal(disposed, false, "release must wait while accepted input is pending");
	agent.pendingFlag = false;
	agent.ctx.emit("agent/inbox/claimed");
	const result = await operation;
	assert.equal(result.outcome, "compacted");
	assert.equal(disposed, true, "release happens after the inbox drains");
});

test("cold R1: pending in the loaded snapshot strands the handle instead of cancelling it", async () => {
	const agent = drainAgentStub("cold-1", { pending: true });
	agent.inbox.agent = agent;
	let disposed = false;
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		hostEngine: { compactNow: async () => assert.fail("engine must not run over pending input") }
	});
	harness.resumed.agent = agent;
	harness.resumed.dispose = async () => { disposed = true; };
	const result = await harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "pending-input");
	assert.match(result.text, /resident|untouched/i);
	assert.equal(harness.resumeCalls.length, 1);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(disposed, false, "the stranded handle must not be disposed while its input is pending");

	// The stranding drain is registered as an unload-abortable operation:
	// plugin unload terminates it through the ordinary dispose.
	for (const disposer of [...harness.registrations.effectDisposers].reverse()) {
		await (typeof disposer === "function" ? disposer() : disposer);
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(disposed, true, "unload terminates the strand through dispose");
});

test("cold R1: unload during the release cutoff terminates through dispose", async () => {
	const agent = drainAgentStub("cold-1");
	agent.inbox.agent = agent;
	// Accepted mid-window; unload arrives while the cutoff is still parked.
	const engine = { compactNow: async () => {
		agent.pendingFlag = true;
		return { shadowedSeqs: [1], shadowedTokenCount: 5, summarySeq: 3 };
	} };
	let disposed = false;
	const harness = makeColdHarness({
		observationSpec: { events: [continuableDescriptorEvent()], values: { inbox: { "next-turn": [], "next-step": [] } } },
		hostEngine: engine
	});
	harness.resumed.agent = agent;
	harness.resumed.dispose = async () => { disposed = true; };
	const operation = harness.tool.execute({ session_id: "cold-1" }, { agent: harness.caller, signal: new AbortController().signal });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(disposed, false, "cutoff holds while input is pending");
	for (const disposer of [...harness.registrations.effectDisposers].reverse()) {
		await (typeof disposer === "function" ? disposer() : disposer);
	}
	const result = await operation;
	assert.equal(result.outcome, "compacted");
	assert.equal(disposed, true, "unload terminates the cutoff through the ordinary dispose");
});
