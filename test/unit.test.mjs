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

/** Error-shape peer of the host's SubagentError (matched by name+code). */
class StubSubagentError extends Error {
	constructor(code, message) {
		super(message ?? `subagent failure ${code}`);
		this.name = "SubagentError";
		this.code = code;
	}
}

function makeHarness({ agent, owned = true, resident = true, presets, hostEngine, children, config, resume } = {}) {
	const caller = { id: "parent-1", label: "caller" };
	const registrations = { commands: [], tools: [], effects: [], effectDisposers: [], listeners: [] };
	const sendCalls = [];
	/* Mutable residency so a resume scenario can materialize the live agent
	 * at exactly the moment the host's start edge fires. */
	const residency = { current: resident && agent !== undefined ? agent : undefined };
	const ctx = {
		agents: {
			get: (id) => (residency.current !== undefined && id === residency.current.id ? residency.current : undefined),
			isOwnedBy: (id, owner) => owned && owner === caller && residency.current !== undefined && id === residency.current.id
		},
		subagents: {
			listChildren: children ?? (async () => [{ id: "child-1", mode: "continuable", label: "worker" }]),
			/* The host's wake delivery; tests override per scenario. The
			 * default refuses the resume like a real unrestorable child. */
			sendMessage: async (sender, targetId, content, options) => {
				sendCalls.push({ sender, targetId, content, options });
				if (resume?.sendMessage !== undefined) return resume.sendMessage(sender, targetId, content, options);
				throw new StubSubagentError("NOT_RESUMABLE", `subagent "${targetId}" has no supported continuation state`);
			}
		},
		on(eventName, listener) {
			const entry = { eventName, listener };
			registrations.listeners.push(entry);
			return () => {
				const index = registrations.listeners.indexOf(entry);
				if (index >= 0) registrations.listeners.splice(index, 1);
			};
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
	/** Emit one lifecycle edge exactly like the contained host emitter would. */
	const emit = (eventName, info) => {
		for (const { eventName: registered, listener } of [...registrations.listeners]) {
			if (registered !== eventName) continue;
			try {
				listener(info);
			} catch {
				/* the host logs and continues */
			}
		}
	};
	return { ctx, caller, command, tool, registrations, sendCalls, emit, residency };
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
	assert.equal(Config({}).resumeCapacityTimeoutMs, 120_000);
	assert.equal(Config({ resumeCapacityTimeoutMs: 600_000 }).resumeCapacityTimeoutMs, 600_000);
	for (const value of [0, -1, 1.5, 600_001, Infinity]) assert.throws(() => Config({ resumeCapacityTimeoutMs: value }));
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

test("not-resident when no live agent has the id and resume is disabled", async () => {
	const harness = makeHarness({ agent: undefined, resident: false, config: { resumeInactive: false } });
	const result = await harness.command.handler(invocation(harness, "ghost"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /No live agent with session id "ghost"/);
});

test("a settled child whose wake is refused reports not-resumable", async () => {
	const harness = makeHarness({ agent: undefined, resident: false });
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /cannot be resumed/);
});

test("resumes a settled continuable child and compacts through the synchronous start edge", async () => {
	const agent = makeAgent();
	const harness = makeHarness({
		agent,
		resident: false,
		hostEngine: {
			async compactNow(target) {
				assert.equal(target, agent, "compaction runs against the resumed live agent");
				return { summarySeq: 21, shadowedSeqs: [3, 4], shadowedTokenCount: 900 };
			}
		},
		resume: {
			sendMessage: async () => {
				/* The manager finishes resume, then the start edge fires
				 * synchronously before the message is delivered. */
				harness.residency.current = agent;
				harness.emit("subagent/start", { runId: "run-2", provider: "spawn", id: agent.id, local: true });
				return "wake-1";
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /Resumed and compacted subagent "child-1": replaced 2 history items/);
	assert.match(result.text, /The wake message \(wake-1\) stays in the child's inbox/);
	/* The wake text asks only for a maintenance acknowledgment. */
	const wake = harness.sendCalls[0];
	assert.equal(wake.targetId, "child-1");
	assert.equal(wake.sender, harness.caller);
	assert.match(wake.content[0].text, /\[history-compaction maintenance\]/);
	assert.match(wake.content[0].text, /do not start new work/);
	/* The idle wait was never used on the resume path. */
	assert.equal(agent.whenIdleCalls, 0);
});

test("a wake refused for authorization reports not-authorized", async () => {
	const harness = makeHarness({
		agent: undefined,
		resident: false,
		resume: {
			sendMessage: async () => {
				throw new StubSubagentError("UNAUTHORIZED", "subagent \"child-1\" belongs to another parent session");
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /not your direct runtime child/);
});

test("a busy wake (activation closing) reports busy-target", async () => {
	const harness = makeHarness({
		agent: undefined,
		resident: false,
		resume: {
			sendMessage: async () => {
				throw new StubSubagentError("ACTIVATION_CLOSING", "subagent activation is being disposed");
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /live activity in flight/);
});

test("a target that raced back live without a start edge compacts via the live path", async () => {
	const agent = makeAgent();
	const harness = makeHarness({
		agent,
		resident: false,
		hostEngine: {
			async compactNow() {
				return { summarySeq: 7, shadowedSeqs: [2], shadowedTokenCount: 100 };
			}
		},
		resume: {
			sendMessage: async () => {
				/* Another continuation resumed the child; no start edge of
				 * ours fires, but the agent is live when the wake resolves. */
				harness.residency.current = agent;
				return "wake-1";
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /Compacted subagent "child-1"/);
	assert.doesNotMatch(result.text, /Resumed and compacted/);
});

test("a wake that neither starts nor materializes reports resume-failed", async () => {
	const harness = makeHarness({
		agent: undefined,
		resident: false,
		resume: { sendMessage: async () => "wake-1" }
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /without a resume start edge or a live agent/);
});

test("the start edge resolves the engine before compacting; a missing engine refuses", async () => {
	const agent = makeAgent();
	const harness = makeHarness({
		agent,
		resident: false,
		resume: {
			sendMessage: async () => {
				harness.residency.current = agent;
				harness.emit("subagent/start", { runId: "run-2", provider: "spawn", id: agent.id, local: true });
				return "wake-1";
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /no agent preset registry and no Host-plane compaction engine/);
});

test("a summary failure during resume keeps the wake delivered and says so", async () => {
	const agent = makeAgent();
	const harness = makeHarness({
		agent,
		resident: false,
		hostEngine: {
			async compactNow() {
				throw new ManualError("summary");
			}
		},
		resume: {
			sendMessage: async () => {
				harness.residency.current = agent;
				harness.emit("subagent/start", { runId: "run-2", provider: "spawn", id: agent.id, local: true });
				return "wake-1";
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /could not produce a useful summary/);
	assert.match(result.text, /wake message stays delivered/);
});

test("cancelling the wake aborts the resume path", async () => {
	const controller = new AbortController();
	const harness = makeHarness({
		agent: undefined,
		resident: false,
		resume: {
			sendMessage: async () => {
				controller.abort();
				throw new StubSubagentError("NOT_RESUMABLE", "refused");
			}
		}
	});
	const result = await harness.command.handler(invocation(harness, "child-1", controller.signal));
	assert.equal(result.kind, "error");
	assert.match(result.text, /cancelled/);
});

test("the model tool resumes a settled continuable child too", async () => {
	const agent = makeAgent();
	const harness = makeHarness({
		agent,
		resident: false,
		hostEngine: {
			async compactNow() {
				return { summarySeq: 5, shadowedSeqs: [1], shadowedTokenCount: 50 };
			}
		},
		resume: {
			sendMessage: async () => {
				harness.residency.current = agent;
				harness.emit("subagent/start", { runId: "run-2", provider: "spawn", id: agent.id, local: true });
				return "wake-1";
			}
		}
	});
	const result = await harness.tool.execute({ session_id: "child-1" }, { agent: harness.caller, signal: new AbortController().signal });
	assert.equal(result.outcome, "compacted");
	assert.equal(result.resumed, true);
	assert.equal(result.summary_seq, 5);
	assert.match(result.text, /Resumed and compacted/);
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
	assert.equal(harness.command.input?.hint, "[all | <subagent-session-id>]");
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
