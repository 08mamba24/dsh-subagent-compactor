/**
 * Integration tests for COLD compaction: compacting a persisted continuable
 * child by id after it finished and was reclaimed, without starting another
 * task or racing the live window (COLD_COMPACTION_PLAN.md).
 *
 * Every test boots a real DSH composition (isolated temp storage, local fake
 * LLM) through test/helpers.mjs. Journeys covered:
 *
 *  1. cold by id: settled child reclaimed → /subagent-compact <id> succeeds →
 *     summary persisted → writer released → same id still continuable;
 *  2. concurrent real input at the restore/summary/release boundary: every
 *     send either fails cleanly BEFORE acceptance or is delivered exactly
 *     once — never a false success, never a lost accepted message;
 *  3. authorization: foreign parent, grandchild, and synthetic malformed /
 *     missing / one-shot / foreign-header / wrong-version descriptors leave
 *     history unchanged;
 *  4. persisted pending input: compaction refuses and preserves the work; a
 *     later normal continuation processes it;
 *  5. same-id contention: a second concurrent compaction reports busy, and a
 *     later re-run reports nothing-to-compact instead of double-compacting;
 *  6. cancellation and summary failure release the writer and leave the
 *     child continuable;
 *  7. preset-registry composition: an independently selected child preset and
 *     a child model different from the parent's are restored; the engine is
 *     resolved inside the preset with no Host-plane fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withComposition, waitFor, readEvents, settleChild, startChild, PROVIDER, MODEL, CHILD_MODEL } from "./helpers.mjs";

const signal = () => new AbortController().signal;

/** Create one parent agent handle and return the live parent Agent. */
async function makeParent(ctx, id = "cold-parent") {
	return (await ctx.agents.create({ sessionId: id, agentOptions: { provider: PROVIDER, model: MODEL } })).agent;
}

/** Snapshot the persisted jsonl bytes of one session for change detection. */
async function persistedBytes(ctx, sessionId) {
	const observation = await ctx.sessionQuery.observeSession(sessionId);
	try {
		return JSON.stringify({ header: observation.header, events: [...observation.events] });
	} finally {
		observation[Symbol.dispose]();
	}
}

/**
 * Build a child with two real turns of history, fully settled and reclaimed.
 * Two turns give the engine a span large enough that a summary verifiably
 * shrinks it; one turn is too thin for the shrink check.
 */
async function settleTwoTurnChild(ctx, parent, fake, childOptions = { agentOptions: { provider: PROVIDER, model: CHILD_MODEL } }) {
	// Reset per child so a previous child's trailing short mode does not thin
	// this child's first (filler) turn — the engine's shrink check needs the span.
	fake.state.mode = "turn";
	fake.state.delayMs = 0;
	const childId = await settleChild(ctx, parent, "Please do the first task.", childOptions);
	fake.state.mode = "turn-short";
	await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Working round 2: please continue and report." }], { signal: signal() });
	await waitFor(async () => {
		const log = await readEvents(ctx, childId);
		return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Round two done."));
	}, 8000);
	await waitFor(() => ctx.agents.get(childId) === undefined);
	return childId;
}

/**
 * Craft a synthetic persisted child session under `parent` by cloning a real
 * child header and appending `events` (seq assigned from 0). Used for
 * descriptor/lineage/pending fixtures that the current runtime cannot
 * produce through its own delegation path.
 */
async function craftSession(ctx, parent, events, headerOverrides = {}) {
	// Clone the real parent header (format/version fields included) and
	// override only the child-identity fields, mirroring childSessionMeta().
	const template = {
		...structuredClone(parent.session.header),
		id: `syn-${randomUUID()}`,
		parentSession: parent.id,
		isSeeded: false,
		origin: "subagent",
		delegationDepth: 1,
		...headerOverrides
	};
	for (const [key, value] of Object.entries(template)) if (value === undefined) delete template[key];
	const persistence = ctx.get("sessionPersistence");
	const handle = await persistence.create({ ...template, createdAt: Date.now() }, { inheritedEventCount: 0 });
	try {
		/* Stored v4 event records require type/seq/time/data; a missing `time`
		 * makes the read-side validator drop the record entirely. */
		if (events.length > 0) {
			const stamped = events.map((event, index) => ({ time: Date.now(), ...event, seq: index }));
			await handle.append(stamped);
		}
	} finally {
		await handle.close();
	}
	return template.id;
}

/** A valid continuable descriptor payload for crafted sessions. */
function continuableDescriptor(overrides = {}) {
	return {
		version: 3,
		mode: "continuable",
		provider: "spawn",
		label: "crafted worker",
		...overrides
	};
}

test("cold: compact a settled continuable child by id without another task", async () => {
	await withComposition(async (ctx, fake) => {
		// Two real turns of history, settled and reclaimed. The child runs on
		// its own model so parent settlement-acknowledgment turns can be told
		// apart from child traffic in the request log.
		const parent = await makeParent(ctx);
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		assert.equal(ctx.agents.get(childId), undefined, "precondition: settled child was reclaimed");

		// Ordinary completed child, invoked by id: the old build answered
		// `not-resident` here. This is the headline cold regression.
		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(execution.result.kind, "success", `cold compact failed: ${execution.result.text}`);
		assert.match(execution.result.text, /Compacted subagent/);
		assert.match(execution.result.text, /replaced [1-9]\d* history items/);

		// The maintenance writer is released: no live agent remains.
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(ctx.agents.get(childId), undefined, "cold maintenance target must be released after compaction");

		// Compaction events persisted in the child's own log.
		const events = await readEvents(ctx, childId);
		assert.equal(events.filter((event) => event.type === "compaction/summary").length, 1);
		assert.equal(events.filter((event) => event.type === "compaction/end").length, 1);

		// Exactly one child-model summary request, and no ordinary child turn
		// was submitted by the compaction (parent chatter is out of scope).
		const childRequests = fake.state.requests.filter((request) => request.model === CHILD_MODEL);
		const modes = childRequests.map((request) => request.mode);
		assert.equal(modes.filter((mode) => mode === "summarize").length, 1, "exactly one summary request");
		assert.equal(modes.filter((mode) => mode === "turn" || mode === "turn-short").length, 2, "only the two real turns ran; compaction added none");

		// The summary checkpoint entered the model-visible context: the
		// follow-up turn's request payload contains the checkpoint text.
		// (The persisted event log itself only ever grows — shadowing is a
		// surface operation — so byte-shrink is asserted by the live-window
		// suite's token meter, not here.)
		fake.state.mode = "turn2";
		const requestsBeforeFollowup = fake.state.requests.length;
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Please handle the follow-up." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
		}, 8000);
		const followupRequest = fake.state.requests.slice(requestsBeforeFollowup).find((request) => request.model === CHILD_MODEL && request.mode === "turn2");
		assert.notEqual(followupRequest, undefined, "the child's follow-up turn must run on its own model");
		assert.match(JSON.stringify(followupRequest.messages), /Checkpoint summary/, "the compaction checkpoint must replace the shadowed span in context");
	});
});

test("cold: concurrent normal-route sends during the maintenance window are accepted and delivered exactly once", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx);
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		assert.equal(ctx.agents.get(childId), undefined);

		// Slow summary so the window is observably open. The manager-owned
		// maintenance keeps the child resident, so normal routes DELIVER
		// through the manager instead of colliding on the writer.
		fake.state.mode = "summarize";
		fake.state.delayMs = 300;
		const requestsBefore = fake.state.requests.length;
		const executionPromise = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());

		await waitFor(() => fake.state.requests.length > requestsBefore);
		const sends = [];
		for (let index = 0; index < 3; index += 1) {
			sends.push(
				ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: `Concurrent ${index}: deliver me exactly once.` }], { signal: signal() })
					.then((value) => ({ accepted: true, value }), (error) => ({ accepted: false, message: error.message }))
			);
		}
		const results = await Promise.all(sends);
		// Contract: every send is either accepted (and delivered exactly once
		// below) or rejected BEFORE acceptance with a clear error — never a
		// false success.
		for (const result of results) {
			if (result.accepted === false) assert.match(result.message ?? "", /unavailable|resumable|owned|busy|cutoff|accepting input/i);
		}

		const execution = await executionPromise;
		assert.equal(execution.result.kind, "success", `cold compact failed: ${execution.result.text}`);

		// Every accepted send reached the model exactly once; every rejected
		// one appears nowhere. Then a fresh send answers exactly once.
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
		}, 8000).catch(async () => {
			// Some accepted sends may still be draining through settlement
			// turns; nudge once more and wait again.
			await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Retry after the window: please respond." }], { signal: signal() }).catch(() => undefined);
			await waitFor(async () => {
				const log = await readEvents(ctx, childId);
				return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
			}, 8000);
		});
		const log = await readEvents(ctx, childId);
		const userTexts = log.filter((event) => event.type === "user/message").map((event) => JSON.stringify(event.data));
		for (let index = 0; index < 3; index += 1) {
			const occurrences = userTexts.filter((text) => text.includes(`Concurrent ${index}:`)).length;
			const send = results[index];
			if (send.accepted) assert.equal(occurrences, 1, `accepted send ${index} delivered exactly once`);
			else assert.equal(occurrences, 0, `rejected send ${index} must not appear in the log`);
		}
		await assertNoCancelledInboxSplices(ctx, childId, "concurrent window");
	});
});

test("cold: authorization denials leave history unchanged", async () => {
	await withComposition(async (ctx) => {
		const parent = await makeParent(ctx, "auth-parent");
		const foreign = await makeParent(ctx, "auth-foreign");

		// Real settled child of `parent`; a different live parent is refused.
		const childId = await settleChild(ctx, parent, "Please do the first task.");
		const before = await persistedBytes(ctx, childId);
		const foreignExecution = await ctx.commands.execute(foreign, `/subagent-compact ${childId}`, [], signal());
		assert.equal(foreignExecution.result.kind, "error");
		assert.match(foreignExecution.result.text, /belongs to another parent session|not one of your/);
		assert.equal(await persistedBytes(ctx, childId), before, "denial must not touch history");

		// Self target: the caller is live, so the live path's ownership check refuses.
		const selfExecution = await ctx.commands.execute(parent, `/subagent-compact ${parent.id}`, [], signal());
		assert.equal(selfExecution.result.kind, "error");
		assert.match(selfExecution.result.text, /not one of your/);
	});
});

test("cold: grandchild refuses from the root parent", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "grand-root");
		// Keep the child live long enough to spawn its own child under it.
		const activation = await startChild(ctx, parent, "Please run a long first task.");
		const childId = activation.childId;
		const child = await waitFor(() => ctx.agents.get(childId));
		const grandActivation = await ctx.subagents.startActivation({
			provider: "spawn",
			label: "grand worker",
			request: { prompt: [{ type: "text", text: "Grandchild task." }], parent: child },
			signal: signal(),
			delivery: "parent"
		});
		await activation.result;
		await grandActivation.result;
		await waitFor(() => ctx.agents.get(childId) === undefined && ctx.agents.get(grandActivation.childId) === undefined);
		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, `/subagent-compact ${grandActivation.childId}`, [], signal());
		assert.equal(execution.result.kind, "error");
		assert.match(execution.result.text, /belongs to another parent session/);
	});
});

test("cold: synthetic descriptor and lineage rejections leave the store unchanged", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "synth-parent");
		const cases = [
			{
				name: "missing descriptor (history without one)",
				events: [{ type: "turn/start", data: { turn: 1 } }],
				match: /no supported subagent descriptor|cannot be classified/i
			},
			{
				name: "malformed descriptor (unknown field)",
				events: [{ type: "subagent/descriptor", data: { ...continuableDescriptor(), extra: "boom" } }],
				/* Storage-layer format validation may reject the corrupt payload
				 * at read time (before the descriptor fold) — also a denial. */
				match: /unknown field|malformed|could not be observed|corrupt/i
			},
			{
				name: "wrong-version descriptor",
				events: [{ type: "subagent/descriptor", data: { ...continuableDescriptor(), version: 2 } }],
				match: /no supported subagent descriptor/i
			},
			{
				name: "one-shot descriptor",
				events: [{ type: "subagent/descriptor", data: { version: 3, mode: "one-shot", provider: "spawn", label: "once" } }],
				match: /one-shot|mode/i
			},
			{
				name: "foreign lineage header",
				events: [{ type: "subagent/descriptor", data: continuableDescriptor() }],
				headerOverrides: { parentSession: "someone-else" },
				match: /belongs to another parent session/
			}
		];
		for (const testCase of cases) {
			const id = await craftSession(ctx, parent, testCase.events, testCase.headerOverrides ?? {});
			const before = await persistedBytes(ctx, id);
			fake.state.mode = "summarize";
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${id}`, [], signal());
			assert.equal(execution.result.kind, "error", testCase.name);
			assert.match(execution.result.text, testCase.match, testCase.name);
			assert.equal(await persistedBytes(ctx, id), before, `${testCase.name}: store must be untouched`);
			assert.equal(ctx.agents.get(id), undefined, `${testCase.name}: nothing may stay live`);
		}
	});
});

test("cold: persisted pending input refuses compaction and preserves work for continuation", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "pending-parent");

		// Capture a real pending-message splice shape from a live delivery.
		let capturedSplice;
		const stopCapture = ctx.on("session/event", (session, event) => {
			if (event.type === "agent/inbox/spliced" && event.data.inserted.length > 0) capturedSplice = structuredClone(event.data);
		});
		const childId = await settleChild(ctx, parent, "Please do the first task.");
		fake.state.mode = "turn-short";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Capture one inbox splice shape." }], { signal: signal() });
		await waitFor(() => capturedSplice !== undefined, 8000);
		stopCapture();
		await waitFor(() => ctx.agents.get(childId) === undefined);

		// Craft a settled continuable child whose persisted inbox holds work.
		// The captured splice is event DATA; store it wrapped as a full event
		// record (type/seq/time/data).
		const message = capturedSplice.inserted[0];
		message.content = [{ type: "text", text: "Pending work that must survive a compaction refusal." }];
		const pendingId = await craftSession(ctx, parent, [
			{ type: "subagent/descriptor", data: continuableDescriptor({ agentProvider: PROVIDER, agentModel: CHILD_MODEL }) },
			{ type: "agent/inbox/spliced", data: { ...capturedSplice, target: "next-turn", start: 0, inserted: [message] } }
		]);
		const before = await persistedBytes(ctx, pendingId);

		const execution = await ctx.commands.execute(parent, `/subagent-compact ${pendingId}`, [], signal());
		assert.equal(execution.result.kind, "error");
		assert.match(execution.result.text, /pending/i);
		assert.equal(await persistedBytes(ctx, pendingId), before, "refusal must leave the pending work untouched");
		assert.equal(ctx.agents.get(pendingId), undefined, "refusal must not leave a live handle");

		// A later normal continuation processes the pending message once.
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, pendingId, [{ type: "text", text: "Wake up and finish the pending work." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, pendingId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled"));
		}, 8000);
		const log = await readEvents(ctx, pendingId);
		const userTexts = log.filter((event) => event.type === "user/message").map((event) => JSON.stringify(event.data));
		assert.equal(userTexts.filter((text) => text.includes("Pending work that must survive")).length, 1, "pending message processed exactly once");
		assert.equal(userTexts.filter((text) => text.includes("Wake up and finish")).length, 1, "waking message delivered exactly once");
	});
});

test("cold: same-id contention serializes and later re-run reports nothing to compact", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "contend-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		fake.state.mode = "summarize";
		fake.state.delayMs = 250;
		const first = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		const second = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(second.result.kind, "error", "a concurrent second compaction must not both run");
		assert.match(second.result.text, /already in progress|busy|owned/i);
		const firstExecution = await first;
		assert.equal(firstExecution.result.kind, "success", `first compaction: ${firstExecution.result.text}`);

		fake.state.delayMs = 0;
		const rerun = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		/* A sequential re-run legitimately either finds nothing left to
		 * compact, compacts a further range, or reports the engine's own
		 * `summary` shrink refusal on the tiny remainder (its failed attempt
		 * is recorded in the log per the engine's contract) — it must never
		 * double-own the writer or corrupt the log. */
		assert.match(rerun.result.text, /No compactable history yet|Compacted subagent|could not produce a useful summary/);
		const events = await readEvents(ctx, childId);
		assert.equal(events.filter((event) => event.type === "compaction/summary").length, 1, "exactly one committed summary overall");
	});
});

test("cold: cancellation and summary failure release the writer and keep the child continuable", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "cancel-parent");

		// Cancel mid-summary. An aborted command may either settle as an
		// error result or reject with the abort error (the command service's
		// `withAbort` semantics for a UI-owned signal); both are cancellations.
		const cancelId = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		fake.state.delayMs = 200;
		const requestsBefore = fake.state.requests.length;
		const controller = new AbortController();
		const cancelling = ctx.commands.execute(parent, `/subagent-compact ${cancelId}`, [], controller.signal);
		await waitFor(() => fake.state.requests.length > requestsBefore);
		controller.abort(new Error("user cancelled"));
		const cancelled = await cancelling.then(
			(execution) => execution.result,
			(error) => ({ kind: "error", text: String(error?.message ?? error) })
		);
		assert.equal(cancelled.kind, "error");
		assert.match(cancelled.text, /cancel/i);
		await waitFor(() => ctx.agents.get(cancelId) === undefined, 8000);
		const eventsAfterCancel = await readEvents(ctx, cancelId);
		assert.equal(eventsAfterCancel.filter((event) => event.type === "compaction/summary").length, 0, "cancelled compaction must not persist a summary");
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, cancelId, [{ type: "text", text: "Still alive after cancel?" }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, cancelId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled"));
		}, 8000);

		// Summary failure: engine reports `summary`; history and continuation intact.
		const failId = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize-fail";
		const before = await persistedBytes(ctx, failId);
		const failed = await ctx.commands.execute(parent, `/subagent-compact ${failId}`, [], signal());
		assert.equal(failed.result.kind, "error");
		assert.match(failed.result.text, /summary/i);
		await waitFor(() => ctx.agents.get(failId) === undefined, 8000);
		const after = await persistedBytes(ctx, failId);
		assert.notEqual(after, before, "the engine records its own attempt events");
		assert.equal((await readEvents(ctx, failId)).some((event) => event.type === "compaction/summary"), false, "no committed summary");
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, failId, [{ type: "text", text: "Still alive after failure?" }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, failId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled"));
		}, 8000);
	});
});

test("cold: preset-registry composition restores an independent child preset and child model without host fallback", async () => {
	await withComposition(async (ctx, fake) => {
		const presets = ctx.get("agentPresets");
		assert.notEqual(presets, undefined, "preset registry must be composed");
		// The real Host installs the loader's group builtin during app boot
		// (dsh-app-boot/lib/index.js:4177); a bare test composition must too.
		const { Group } = await import("@deepseek-ai/cordis-plugin-loader");
		ctx.loader.builtins.group = Group;
		await presets.register({
			id: "child-preset",
			name: "Child Preset",
			// Mirrors the official Desktop preset: the compaction engine sits
			// inside an isolated group (dsh-web-app/presets/standard.patch.yml).
			plugins: [{
				id: "compaction",
				name: "cordis:group",
				group: true,
				isolate: { compaction: true },
				config: [{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic", config: { auto: false } }]
			}]
		});

		const parent = await makeParent(ctx, "preset-parent");
		// Child selects the preset independently and runs a different model.
		const childId = await settleTwoTurnChild(ctx, parent, fake, {
			agentOptions: { provider: PROVIDER, model: CHILD_MODEL },
			agentPreset: "child-preset"
		});
		assert.equal(ctx.agents.get(childId), undefined);

		const childRequests = fake.state.requests.filter((request) => request.model === CHILD_MODEL);
		assert.ok(childRequests.length >= 1, "the child must have run on its own model");

		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(execution.result.kind, "success", `preset-plane cold compact failed: ${execution.result.text}`);

		const summaryRequests = fake.state.requests.filter((request) => request.mode === "summarize");
		assert.equal(summaryRequests.length, 1);
		assert.equal(summaryRequests[0].model, CHILD_MODEL, "the summary must be produced by the child's restored model, not the parent's");

		await waitFor(() => ctx.agents.get(childId) === undefined);
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Continue after preset compaction." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled"));
		}, 8000);
	}, {
		withoutHostCompaction: true,
		extra: [
			["@deepseek-ai/cordis-plugin-loader", {}],
			["@deepseek-ai/dsh-agent-preset-registry", { default: "child-preset" }]
		]
	});
});

// ---------------------------------------------------------------------------
// R1 regressions (independent review): the cold handle must not discard
// accepted input when it releases, and pending discovered at load time must
// survive without a queue-clearing dispose.

/** Assert one session's log records no durable inbox cancellation. */
async function assertNoCancelledInboxSplices(ctx, sessionId, label) {
	const log = await readEvents(ctx, sessionId);
	const cancellations = log.filter((event) => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled" && (event.data.removedCount ?? 0) > 0);
	assert.deepEqual(cancellations, [], `${label}: accepted input must not be cancelled by the cold handle`);
}

test("cold R1: input accepted during the maintenance window is fully processed before release", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "r1-direct-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		// Slow summary; while it is in flight the restored Agent is live in
		// the public registry and accepts a message through its public input.
		fake.state.mode = "summarize";
		fake.state.delayMs = 400;
		const start = fake.state.requests.length;
		const executionPromise = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		await waitFor(() => fake.state.requests.slice(start).some((request) => request.mode === "summarize" && request.model === CHILD_MODEL));
		const target = ctx.agents.get(childId);
		assert.notEqual(target, undefined, "the restored maintenance agent is live in the registry");
		const sentinel = createUserMessage({ source: { kind: "review-host-message" }, content: [{ type: "text", text: "DIRECT-ACCEPTED-SENTINEL: process this message once" }] });
		target.followup(sentinel);
		assert.equal(target.inbox.hasPending, true, "the public input was accepted");

		const execution = await executionPromise;
		assert.equal(execution.result.kind, "success", `cold compact failed: ${execution.result.text}`);

		// The sentinel was fully processed — model-visible user message plus
		// an assistant answer — before the maintenance handle released.
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("DIRECT-ACCEPTED-SENTINEL"));
			return at >= 0 && log.slice(at).some((event) => event.type === "assistant/message");
		}, 8000, "the sentinel must be fully processed with an assistant answer");
		await assertNoCancelledInboxSplices(ctx, childId, "direct-message window");
		await waitFor(() => ctx.agents.get(childId) === undefined, 8000);

		// Normal continuation of the same id still works, exactly once.
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Follow-up after the sentinel." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			return log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("DIRECT-ACCEPTED-SENTINEL")).length === 1
				&& log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
		}, 8000);
		const log = await readEvents(ctx, childId);
		assert.equal(log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("DIRECT-ACCEPTED-SENTINEL")).length, 1, "sentinel processed exactly once");
	});
});

test("cold R1: accepted input also survives cancellation and summary failure of the compaction", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "r1-cancel-parent");

		// Cancellation mid-summary with an already-accepted sentinel.
		const cancelId = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		fake.state.delayMs = 300;
		const start = fake.state.requests.length;
		const controller = new AbortController();
		const cancelling = ctx.commands.execute(parent, `/subagent-compact ${cancelId}`, [], controller.signal);
		await waitFor(() => fake.state.requests.slice(start).some((request) => request.mode === "summarize" && request.model === CHILD_MODEL));
		const cancelTarget = ctx.agents.get(cancelId);
		cancelTarget.followup(createUserMessage({ source: { kind: "review-host-message" }, content: [{ type: "text", text: "CANCEL-WINDOW-SENTINEL: still process me" }] }));
		controller.abort(new Error("user cancelled"));
		await cancelling.then(() => undefined, () => undefined);
		await waitFor(async () => {
			const log = await readEvents(ctx, cancelId);
			return log.some((event) => event.type === "user/message" && JSON.stringify(event.data).includes("CANCEL-WINDOW-SENTINEL"));
		}, 8000);
		await assertNoCancelledInboxSplices(ctx, cancelId, "cancellation window");
		await waitFor(() => ctx.agents.get(cancelId) === undefined, 8000);

		// Summary failure with an already-accepted sentinel.
		const failId = await settleTwoTurnChild(ctx, parent, fake);
		// Delay the failing response so the sentinel lands while the
		// summary is still in flight (delayMs 0 settles before waitFor polls).
		fake.state.delayMs = 300;
		fake.state.mode = "summarize-fail";
		const failStart = fake.state.requests.length;
		const failing = ctx.commands.execute(parent, `/subagent-compact ${failId}`, [], signal());
		await waitFor(() => fake.state.requests.slice(failStart).some((request) => request.mode === "summarize-fail" && request.model === CHILD_MODEL));
		const failTarget = ctx.agents.get(failId);
		failTarget.followup(createUserMessage({ source: { kind: "review-host-message" }, content: [{ type: "text", text: "FAIL-WINDOW-SENTINEL: still process me" }] }));
		const failed = await failing;
		assert.equal(failed.result.kind, "error");
		assert.match(failed.result.text, /summary/i);
		await waitFor(async () => {
			const log = await readEvents(ctx, failId);
			return log.some((event) => event.type === "user/message" && JSON.stringify(event.data).includes("FAIL-WINDOW-SENTINEL"));
		}, 8000);
		await assertNoCancelledInboxSplices(ctx, failId, "summary-failure window");
		await waitFor(() => ctx.agents.get(failId) === undefined, 8000);
	});
});

test("cold R1: pending injected between precheck and load is preserved and normal routes keep working", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "r1-race-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		// Controlled interleaving (the reviewer's technique): another legal
		// persistence writer enqueues durable work after the plugin's read
		// precheck, before the manager loads the session.
		const originalResume = ctx.agents.resume.bind(ctx.agents);
		let messageId;
		ctx.agents.resume = async (options) => {
			if (options.resumeSessionId === childId && messageId === undefined) {
				const writer = await ctx.get("sessionPersistence").open(childId, "write");
				try {
					const snapshot = await writer.read(0);
					const message = createUserMessage({ source: { kind: "review-persistent-producer" }, content: [{ type: "text", text: "PRECHECK-RACE-SENTINEL: preserve pending work" }] });
					messageId = message.id;
					await writer.append([{ seq: snapshot.events.length, time: Date.now(), type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message] } }]);
				} finally {
					await writer.close();
				}
			}
			return originalResume(options);
		};
		try {
			fake.state.mode = "summarize";
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
			// Under the manager-owned lifecycle, compaction alongside durable
			// pending is lawful and lossless: the job never touches the
			// inbox, and settlement keeps the child resident until that work
			// is processed. Either refusal (pending-input) or success is an
			// honest outcome; loss is not.
			assert.ok(execution.result.kind === "success" || (execution.result.kind === "error" && /pending/i.test(execution.result.text)), `honest outcome required: ${execution.result.text}`);
			await assertNoCancelledInboxSplices(ctx, childId, "precheck race");

			// Normal routes work throughout: a sendMessage delivers and the
			// injected sentinel is processed exactly once, with an answer.
			fake.state.mode = "turn2";
			await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Wake the child: finish the pending work." }], { signal: signal() });
			await waitFor(async () => {
				const log = await readEvents(ctx, childId);
				const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL"));
				return at >= 0 && log.slice(at).some((event) => event.type === "assistant/message");
			}, 8000);
			const log = await readEvents(ctx, childId);
			assert.equal(log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL")).length, 1, "injected work processed exactly once");
		} finally {
			ctx.agents.resume = originalResume;
		}
	});
});

// ---------------------------------------------------------------------------
// R2 acceptance-contract regressions. DEFAULT mode asserts the contract
// (accepted input is never lost; normal routes keep working; unload loses
// nothing) against the manager-owned maintenance runtime. `GAP_DIAG=1`
// asserts instead that the runtime LACKS the capability (diagnosing the
// stock 0.2.1-rc.2 tree: point node_modules at it and set GAP_DIAG=1) —
// on the patched runtime GAP_DIAG fails as an unexpected pass, prompting
// removal. The interleavings are the reviewer's own proofs: a public
// AgentHandle.dispose wrapper for the release cutoff, a second legal
// persistence writer for the precheck race, and a plugin-only fiber unload.

const GAP = process.env.GAP_DIAG === "1";
const CONTRACT = !GAP;
/** In GAP mode, a stock runtime either lacks ctx.subagents.runMaintenance or refuses through it. */
function isStockRefusal(execution) {
	return execution.result.kind === "error" && /maintenance capability/.test(execution.result.text);
}

/** Record whether one public input attempt was accepted or cleanly rejected. */
async function attemptFollowup(agent, message) {
	try {
		agent.followup(message);
		return { accepted: true };
	} catch (error) {
		return { accepted: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/** Contract: accepted → processed exactly once; rejected → explicit, nothing enqueued. */
async function assertFollowupOutcome(ctx, sessionId, attempt, marker, label) {
	const log = await readEvents(ctx, sessionId);
	const occurrences = log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes(marker)).length;
	if (attempt.accepted) {
		if (CONTRACT) {
			assert.ok(occurrences >= 1, `${label}: the accepted message must reach the model`);
			const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes(marker));
			assert.ok(log.slice(at).some((event) => event.type === "assistant/message"), `${label}: the accepted message must receive an answer`);
		} else {
			assert.equal(occurrences, 0, `${label} (gap): the accepted message is dropped today`);
		}
	} else {
		assert.match(attempt.message ?? "", /cutoff|accepting input|unavailable|resumable|owned|busy/i, `${label}: a rejection must be explicit`);
		assert.equal(occurrences, 0, `${label}: a rejected message must not appear in the log`);
	}
}

test("cold R2: input at the release cutoff (contract default; GAP_DIAG for stock)", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "r2-cutoff-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		const originalResume = ctx.agents.resume.bind(ctx.agents);
		let injected = false;
		let cutoffAttempt;
		ctx.agents.resume = async (options) => {
			const handle = await originalResume(options);
			if (options.resumeSessionId !== childId) return handle;
			return {
				...handle,
				dispose: async () => {
					if (!injected) {
						injected = true;
						cutoffAttempt = await attemptFollowup(handle.agent, createUserMessage({ source: { kind: "review-release-cutoff" }, content: [{ type: "text", text: "RELEASE-CUTOFF-SENTINEL: preserve accepted work" }] }));
					}
					return handle.dispose();
				}
			};
		};
		try {
			fake.state.mode = "summarize";
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
			if (GAP) {
				// The stock runtime never resumes the child: no maintenance,
				// no wrapped dispose, no cutoff moment at all.
				assert.ok(isStockRefusal(execution) && cutoffAttempt === undefined, "gap: the stock runtime refuses cold compaction (no capability)");
				return;
			}
			// Settlement closes asynchronously after the job settles; wait for
			// the wrapped dispose (the cutoff moment) before asserting.
			await waitFor(() => cutoffAttempt !== undefined, 8000);
			await assertFollowupOutcome(ctx, childId, cutoffAttempt, "RELEASE-CUTOFF-SENTINEL", "release cutoff");
			await assertNoCancelledInboxSplices(ctx, childId, "release cutoff");
			// A compaction whose input fate is safe (processed or cleanly
			// rejected) may honestly report success.
			assert.equal(execution.result.kind, "success", execution.result.text);
		} finally {
			ctx.agents.resume = originalResume;
		}
	});
});

/** Shared precheck-race injection: another legal writer adds durable pending. */
async function injectPrecheckRace(ctx, childId, marker) {
	const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
	const originalResume = ctx.agents.resume.bind(ctx.agents);
	let messageId;
	ctx.agents.resume = async (options) => {
		if (options.resumeSessionId === childId && messageId === undefined) {
			const writer = await ctx.get("sessionPersistence").open(childId, "write");
			try {
				const snapshot = await writer.read(0);
				const message = createUserMessage({ source: { kind: "review-persistent-producer" }, content: [{ type: "text", text: `${marker}: preserve pending work` }] });
				messageId = message.id;
				await writer.append([{ seq: snapshot.events.length, time: Date.now(), type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message] } }]);
			} finally {
				await writer.close();
			}
		}
		return originalResume(options);
	};
	return () => { ctx.agents.resume = originalResume; };
}

test("cold R2: normal-route continuation of a child with injected pending (contract default; GAP_DIAG for stock)", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "r2-strand-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		const restore = await injectPrecheckRace(ctx, childId, "PRECHECK-RACE-SENTINEL");
		try {
			fake.state.mode = "summarize";
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
			if (GAP) assert.ok(isStockRefusal(execution) || execution.result.kind === "success" || /pending/i.test(execution.result.text), `gap outcome: ${execution.result.text}`);
			else assert.ok(execution.result.kind === "success" || (execution.result.kind === "error" && /pending/i.test(execution.result.text)), `honest outcome required: ${execution.result.text}`);

			// Normal routes: model sendMessage + addressed UI queue prompt.
			const attempts = [];
			for (let index = 0; index < 2; index += 1) {
				attempts.push(
					ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: `Normal retry ${index}` }], { signal: signal() })
						.then(() => ({ accepted: true }), (error) => ({ accepted: false, message: error.message }))
				);
			}
			attempts.push(
				ctx.subagents.prompt({ parentSessionId: parent.id, childSessionId: childId, mode: "continuable", delivery: "queue", requestId: "r2-strand-queue", content: [{ type: "text", text: "Normal addressed UI queue retry" }] }, signal())
					.then(() => ({ route: "addressed-queue", accepted: true }), (error) => ({ route: "addressed-queue", accepted: false, message: error.message }))
			);
			const results = await Promise.all(attempts);
			const anyAccepted = results.some((result) => result.accepted);
			if (CONTRACT) {
				assert.ok(anyAccepted, `a normal route must accept while the child holds pending work: ${JSON.stringify(results.map((result) => result.accepted))}`);
				await waitFor(async () => {
					const log = await readEvents(ctx, childId);
					const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL"));
					return at >= 0 && log.slice(at).some((event) => event.type === "assistant/message");
				}, 8000);
				const log = await readEvents(ctx, childId);
				assert.equal(log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL")).length, 1, "injected work processed exactly once");
			} else {
				assert.ok(isStockRefusal(execution) || anyAccepted === false, "gap: the stock runtime refuses cold compaction or refuses the normal routes");
				await assertNoCancelledInboxSplices(ctx, childId, "strand normal route");
			}
			if (CONTRACT) await assertNoCancelledInboxSplices(ctx, childId, "strand normal route");
		} finally {
			restore();
		}
	});
});

test("cold R2: plugin unload with parked pending (contract default; GAP_DIAG for stock)", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "r2-unload-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		const restore = await injectPrecheckRace(ctx, childId, "PRECHECK-RACE-SENTINEL");
		try {
			fake.state.mode = "summarize";
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
			if (GAP) {
				// The stock runtime refuses before any restore, so nothing was
				// injected, parked, or lost: the diagnosis is the refusal itself.
				assert.ok(isStockRefusal(execution), "gap: the stock runtime refuses cold compaction (no capability, nothing parked)");
				return;
			}
			assert.ok(execution.result.kind === "success" || (execution.result.kind === "error" && /pending/i.test(execution.result.text)), `honest outcome required: ${execution.result.text}`);

			// Unload ONLY the compactor plugin; the Host, query, and store stay.
			await ctx.compactorFiber.dispose();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const observation = await ctx.sessionQuery.observeSession(childId);
			let pendingCount;
			let cancelledSplices;
			try {
				const inbox = observation.projections?.values?.inbox;
				pendingCount = (inbox?.["next-turn"]?.length ?? 0) + (inbox?.["next-step"]?.length ?? 0);
				cancelledSplices = [...observation.events].filter((event) => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled" && (event.data.removedCount ?? 0) > 0).length;
			} finally {
				observation[Symbol.dispose]();
			}
			if (CONTRACT) {
				assert.ok(pendingCount > 0 || cancelledSplices === 0, "parked pending survives the plugin unload (or was already processed)");
				assert.equal(cancelledSplices, 0, "unload must not durably cancel parked input");
				// The SAME message id continues normally afterwards.
				fake.state.mode = "turn2";
				await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Continue after unload." }], { signal: signal() });
				await waitFor(async () => {
					const log = await readEvents(ctx, childId);
					const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL"));
					if (at < 0) return false;
					const followupAt = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("Continue after unload."));
					const answered = log.slice(at).some((event) => event.type === "assistant/message");
					return answered && followupAt >= 0 && log.slice(followupAt).some((event) => event.type === "assistant/message");
				}, 8000);
				const log = await readEvents(ctx, childId);
				assert.equal(log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("PRECHECK-RACE-SENTINEL")).length, 1, "the original pending work processed exactly once after unload");
			} else {
				assert.equal(pendingCount, 0, "gap: stock unload cancels the parked input");
				assert.ok(cancelledSplices > 0, "gap: the cancellation is recorded");
			}
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Host-capability evidence (patched runtime): the loop-level admission
// cutoff on both sides, and claimed-batch restoration on an aborted turn.

test("cold host capability: closing input rejects public input before acceptance", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "cutoff-direct-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		// Bring the child live through a normal continuation, then close its
		// input surface the way the manager's close transaction does.
		fake.state.mode = "turn-short";
		fake.state.delayMs = 150;
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Bring me live." }], { signal: signal() });
		const agent = await waitFor(() => ctx.agents.get(childId), 3000);
		await new Promise((resolve) => setTimeout(resolve, 250));
		agent.closeInput();

		// After the cutoff: every public input surface rejects BEFORE the
		// durable enqueue — no exception-free acceptance, no inbox write.
		const attempts = [
			["followup", () => agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "AFTER-CUTOFF followup" }] }))],
			["steer", () => agent.steer(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "AFTER-CUTOFF steer" }] }))],
			["inject", () => agent.inject(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "AFTER-CUTOFF inject" }] }))]
		];
		for (const [name, attempt] of attempts) {
			assert.throws(attempt, /no longer accepting input|cutoff/i, `${name} must be rejected after the cutoff`);
		}
		const observation = await ctx.sessionQuery.observeSession(childId);
		try {
			const log = [...observation.events];
			assert.equal(log.filter((event) => JSON.stringify(event.data ?? {}).includes("AFTER-CUTOFF")).length, 0, "nothing after the cutoff may reach the log");
		} finally {
			observation[Symbol.dispose]();
		}
	});
});

test("cold host capability: an aborted running turn keeps its claimed input exactly once (keepInbox)", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "claim-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);

		// A slow turn: the message is claimed by the turn. Whether it has
		// reached the log yet or not, a keepInbox abort must leave it
		// exactly once: committed as user/message, or restored to the inbox.
		fake.state.mode = "turn-short";
		fake.state.delayMs = 400;
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "CLAIM-SENTINEL: count me exactly once" }], { signal: signal() });
		const agent = await waitFor(() => ctx.agents.get(childId), 3000);
		await waitFor(() => fake.state.requests.some((request) => request.mode === "turn-short" && request.model === CHILD_MODEL && JSON.stringify(request.messages ?? []).includes("CLAIM-SENTINEL")), 8000);
		// The request is in flight: the claimed batch is committed to the log
		// by now; abort the turn the way the manager's drain-stop does.
		agent.cancel({ kind: "parent" }, { keepInbox: true });
		await waitFor(async () => {
			const observation = await ctx.sessionQuery.observeSession(childId);
			try {
				return [...observation.events].some((event) => event.type === "turn/end" && event.data.reason?.kind === "aborted");
			} finally {
				observation[Symbol.dispose]();
			}
		}, 8000);

		const observation = await ctx.sessionQuery.observeSession(childId);
		let committed;
		let cancelledSplices;
		try {
			const log = [...observation.events];
			committed = log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("CLAIM-SENTINEL")).length;
			cancelledSplices = log.filter((event) => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled" && (event.data.removedCount ?? 0) > 0).length;
		} finally {
			observation[Symbol.dispose]();
		}
		assert.equal(cancelledSplices, 0, "a keepInbox abort never durably cancels input");
		assert.ok(committed === 1 || agent.inbox.hasPending === true, "the claimed input is either committed exactly once or durably pending");

		// And it is processed exactly once overall afterwards.
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Finish the counted work." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			const at = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("CLAIM-SENTINEL"));
			if (at < 0) return false;
			const finishAt = log.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("Finish the counted work."));
			return finishAt >= 0 && log.slice(finishAt).some((event) => event.type === "assistant/message");
		}, 8000);
		const log = await readEvents(ctx, childId);
		assert.equal(log.filter((event) => event.type === "user/message" && JSON.stringify(event.data).includes("CLAIM-SENTINEL")).length, 1, "the claimed input appears exactly once overall");
	});
});

// ---------------------------------------------------------------------------
// R4 host-capability regressions (review round 4 proofs, formalized).

test("cold host capability: input claimed inside pre-step survives a keepInbox abort", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const handle = await ctx.agents.create({ sessionId: "r4-claim-abort", agentOptions: { provider: PROVIDER, model: MODEL } });
		const agent = handle.agent;
		try {
			// Abort inside the pre-step waterfall: the sentinel is CLAIMED but
			// the turn has not yet decided, let alone committed it.
			const unhook = ctx.on("agent/pre-step", async (payload, next) => {
				if (payload.agent === agent && payload.messages.some((message) => JSON.stringify(message).includes("PRESTEP-CLAIM-SENTINEL"))) {
					agent.cancel({ kind: "parent" }, { keepInbox: true });
				}
				return next();
			});
			const input = createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "PRESTEP-CLAIM-SENTINEL: must remain durable after abort" }] });
			agent.followup(input);
			await agent.whenIdle();
			unhook();

			const observation = await ctx.sessionQuery.observeSession(agent.id);
			let pending;
			let log;
			try {
				pending = observation.projections?.values?.inbox;
				log = [...observation.events];
			} finally {
				observation[Symbol.dispose]();
			}
			const committed = log.filter((event) => event.type === "user/message" && event.data.id === input.id).length;
			const cancelled = log.filter((event) => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled" && (event.data.removedCount ?? 0) > 0).length;
			assert.ok(log.some((event) => event.type === "turn/end" && event.data.reason?.kind === "aborted"), "the turn records its abort");
			assert.equal(cancelled, 0, "a keepInbox abort never durably cancels input");
			const pendingHasIt = ((pending?.["next-turn"]?.length ?? 0) + (pending?.["next-step"]?.length ?? 0)) > 0;
			assert.ok(committed === 1 || pendingHasIt, "the claimed sentinel is committed exactly once or durably pending — never lost");

			// Either way it is processed exactly once afterwards.
			fake.state.mode = "turn2";
			agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Drive the restored work." }] }));
			await waitFor(async () => {
				const events = await readEvents(ctx, agent.id);
				return events.filter((event) => event.type === "user/message" && event.data.id === input.id).length === 1
					&& events.some((event) => event.type === "assistant/message");
			}, 8000);
			const events = await readEvents(ctx, agent.id);
			assert.equal(events.filter((event) => event.type === "user/message" && event.data.id === input.id).length, 1, "exactly once overall");
		} finally {
			await handle.dispose({ keepInbox: true }).catch(() => undefined);
		}
	});
});

test("cold host capability: a pre-step rejection stays blocked, not a TypeError", async () => {
	await withComposition(async (ctx) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const handle = await ctx.agents.create({ sessionId: "r4-reject", agentOptions: { provider: PROVIDER, model: MODEL } });
		const agent = handle.agent;
		const errors = [];
		const unerr = ctx.on("agent/error", (payload) => { if (payload.agent === agent) errors.push(payload.error?.message); });
		const unhook = ctx.on("agent/pre-step", async (payload, next) => payload.agent === agent ? { kind: "reject" } : next());
		try {
			agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Should be rejected as blocked, not TypeError." }] }));
			await agent.whenIdle();
			const log = await readEvents(ctx, agent.id);
			const ends = log.filter((event) => event.type === "turn/end").map((event) => event.data.reason?.kind);
			assert.ok(ends.includes("blocked"), `the rejection ends the turn as blocked: ${JSON.stringify(ends)}`);
			assert.equal(errors.filter((message) => /iterable|not a function|TypeError/i.test(message ?? "")).length, 0, "no TypeError may replace the rejection");
		} finally {
			unhook();
			unerr();
			await handle.dispose({ keepInbox: true }).catch(() => undefined);
		}
	});
});

test("cold host capability: the manager stop transaction preserves accepted input (drainChildren)", async () => {
	await withComposition(async (ctx, fake) => {
		const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
		const parent = await makeParent(ctx, "r4-stop-parent");
		fake.state.delayMs = 200;
		const activation = await startChild(ctx, parent, "Work while I stop you");
		const childId = activation.childId;
		await waitFor(() => fake.state.requests.length > 0);
		const agent = ctx.agents.get(childId);
		const sentinel = createUserMessage({ source: { kind: "review-host" }, content: [{ type: "text", text: "STOP-PRESERVE-SENTINEL: survive the stop" }] });
		agent.inject(sentinel);
		assert.equal(agent.inbox.nextStep.some((message) => message.id === sentinel.id), true, "the injection was accepted");

		await ctx.subagents.drainChildren(parent, [childId]);
		await waitFor(() => ctx.agents.get(childId) === undefined, 8000);

		const observation = await ctx.sessionQuery.observeSession(childId);
		let pending;
		let log;
		try {
			pending = observation.projections?.values?.inbox;
			log = [...observation.events];
		} finally {
			observation[Symbol.dispose]();
		}
		const cancelled = log.filter((event) => event.type === "agent/inbox/spliced" && event.data.outcome === "canceled" && (event.data.removedCount ?? 0) > 0).length;
		const pendingHasIt = [...(pending?.["next-turn"] ?? []), ...(pending?.["next-step"] ?? [])].some((message) => message.id === sentinel.id);
		const committed = log.filter((event) => event.type === "user/message" && event.data.id === sentinel.id).length;
		assert.equal(cancelled, 0, "the stop transaction never durably cancels accepted input");
		assert.ok(pendingHasIt || committed === 1, "the accepted sentinel survives pending or committed exactly once");

		// The same id continues normally and processes the sentinel exactly once.
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Continue after the stop." }], { signal: signal() });
		await waitFor(async () => {
			const events = await readEvents(ctx, childId);
			const at = events.findIndex((event) => event.type === "user/message" && event.data.id === sentinel.id);
			if (at < 0) return false;
			const followAt = events.findIndex((event) => event.type === "user/message" && JSON.stringify(event.data).includes("Continue after the stop."));
			return followAt >= 0 && events.slice(followAt).some((event) => event.type === "assistant/message");
		}, 8000);
		const events = await readEvents(ctx, childId);
		assert.equal(events.filter((event) => event.type === "user/message" && event.data.id === sentinel.id).length, 1, "exactly once overall");
	});
});

test("cold host capability: runMaintenance succeeds without a signal", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "r4-nosignal-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		const answer = await ctx.subagents.runMaintenance(parent, childId, { job: async () => 42 });
		assert.equal(answer, 42, "an omitted signal is legal: the entry normalizes one internally");
	});
});

// ---------------------------------------------------------------------------
// Batch compaction (--all / compact_all_subagents): one catalog snapshot of
// the calling parent, serialized per-item compaction, honest per-item and
// summary reporting, cancellation that never claims success.

test("batch: compacts every settled continuable child in the snapshot, both entries survive and continue", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-parent");
		const first = await settleTwoTurnChild(ctx, parent, fake);
		const second = await settleTwoTurnChild(ctx, parent, fake);

		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		assert.equal(execution.result.kind, "success", execution.result.text);
		assert.match(execution.result.text, new RegExp(first));
		assert.match(execution.result.text, new RegExp(second));
		assert.match(execution.result.text, /compacted 2/);

		for (const childId of [first, second]) {
			const log = await readEvents(ctx, childId);
			assert.equal(log.filter((event) => event.type === "compaction/summary").length, 1, `${childId}: one summary persisted`);
		}
		// Both continue normally afterwards.
		fake.state.mode = "turn2";
		for (const [index, childId] of [first, second].entries()) {
			await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: `Follow-up ${index}.` }], { signal: signal() });
		}
		await waitFor(async () => {
			const logs = await Promise.all([first, second].map((id) => readEvents(ctx, id)));
			return logs.every((log) => log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled")));
		}, 8000);
	});
});

test("batch: tool entry compacts the same snapshot", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-tool-parent");
		const first = await settleTwoTurnChild(ctx, parent, fake);
		const second = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		const tool = ctx.tools.get("compact_all_subagents");
		assert.notEqual(tool, undefined, "the batch tool must be registered");
		const result = await tool.execute({}, { agent: parent, signal: new AbortController().signal });
		assert.equal(result.outcome, "completed");
		assert.equal(result.total, 2);
		assert.equal(result.compacted, 2);
		assert.equal(result.not_started, 0);
		for (const childId of [first, second]) {
			const log = await readEvents(ctx, childId);
			assert.equal(log.filter((event) => event.type === "compaction/summary").length, 1);
		}
	});
});

/** Register a crafted child id into the parent's durable catalog projection. */
function registerCatalogChild(ctx, parent, childId, mode, label = "crafted") {
	parent.session.append("subagent/catalog", { version: 0, childId, childCreatedAt: Date.now(), mode, label });
}

test("batch: mixed catalog — per-item outcomes, later items continue, stats add up", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-mixed-parent");
		const good = await settleTwoTurnChild(ctx, parent, fake);
		const emptyChild = await craftSession(ctx, parent, [
			{ type: "subagent/descriptor", data: continuableDescriptor() }
		]);
		registerCatalogChild(ctx, parent, emptyChild, "continuable");
		const oneShot = await craftSession(ctx, parent, [
			{ type: "subagent/descriptor", data: { version: 3, mode: "one-shot", provider: "spawn", label: "once" } }
		]);
		registerCatalogChild(ctx, parent, oneShot, "one-shot");
		const captured = await captureInboxSplice(ctx, parent, fake);
		const message = captured.inserted[0];
		message.content = [{ type: "text", text: "PENDING batch refusal." }];
		const pending = await craftSession(ctx, parent, [
			{ type: "subagent/descriptor", data: continuableDescriptor({ agentProvider: PROVIDER, agentModel: CHILD_MODEL }) },
			{ type: "agent/inbox/spliced", data: { ...captured, target: "next-turn", start: 0, inserted: [message] } }
		]);
		registerCatalogChild(ctx, parent, pending, "continuable");

		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		assert.equal(execution.result.kind, "success", execution.result.text);
		// Catalog order: good, emptyChild, oneShot, pending, plus the capture probe.
		assert.match(execution.result.text, /total \d+/);
		assert.match(execution.result.text, new RegExp(good));
		assert.match(execution.result.text, new RegExp(emptyChild));
		assert.match(execution.result.text, new RegExp(oneShot));
		assert.match(execution.result.text, new RegExp(pending));
		// The crafted one-shot and pending children are refused honestly and
		// never hide the rest; the empty one reports nothing to compact.
		assert.match(execution.result.text, new RegExp(`${oneShot}: unsupported-target`));
		assert.match(execution.result.text, new RegExp(`${pending}: pending-input`));
		assert.match(execution.result.text, new RegExp(`${emptyChild}: nothing-to-compact`));
		assert.match(execution.result.text, /failed [1-9]/);
		const goodLog = await readEvents(ctx, good);
		assert.equal(goodLog.filter((event) => event.type === "compaction/summary").length, 1);
		const pendingObservation = await ctx.sessionQuery.observeSession(pending);
		try {
			const inbox = pendingObservation.projections?.values?.inbox;
			assert.ok(((inbox?.["next-turn"]?.length ?? 0) + (inbox?.["next-step"]?.length ?? 0)) > 0, "pending work untouched");
		} finally {
			pendingObservation[Symbol.dispose]();
		}
	});
});

/** Capture one real inbox splice payload from a live delivery (batch fixtures). */
async function captureInboxSplice(ctx, parent, fake) {
	const probeId = await settleChild(ctx, parent, "capture probe", { agentOptions: { provider: PROVIDER, model: CHILD_MODEL } });
	let captured;
	const stop = ctx.on("session/event", (session, event) => {
		if (event.type === "agent/inbox/spliced" && event.data.inserted.length > 0 && session.id === probeId) captured = structuredClone(event.data);
	});
	fake.state.mode = "turn-short";
	await ctx.subagents.sendMessage(parent, probeId, [{ type: "text", text: "capture" }], { signal: signal() });
	await waitFor(() => captured !== undefined, 8000);
	stop();
	await waitFor(() => ctx.agents.get(probeId) === undefined);
	return captured;
}

test("batch: abort mid-run stops unstarted items and keeps finished results", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-cancel-parent");
		const ids = [];
		for (let index = 0; index < 3; index += 1) ids.push(await settleTwoTurnChild(ctx, parent, fake));

		fake.state.mode = "summarize";
		fake.state.delayMs = 250;
		const controller = new AbortController();
		const run = ctx.commands.execute(parent, "/subagent-compact --all", [], controller.signal);
		// Abort while the FIRST child's summary is in flight.
		const start = fake.state.requests.length;
		await waitFor(() => fake.state.requests.length > start);
		controller.abort(new Error("user cancelled"));
		// An aborted command may settle as an error result or reject with the
		// abort error (the command service's withAbort semantics); both are
		// cancellations, never success.
		const execution = await run.then(
			(settled) => settled.result,
			(error) => ({ kind: "error", text: String(error?.message ?? error) })
		);
		assert.equal(execution.kind, "error", "a cancelled batch must not report success");
		if (execution.text?.includes("Summary")) {
			assert.match(execution.text, /not-started: 2/);
			assert.match(execution.text, new RegExp(ids[0]));
		} else {
			// The operation promise continues in the background after the
			// command rejected; wait for the batch text via the session logs —
			// first child compacted or cancelled, later ones never started.
			await waitFor(async () => {
				const logs = await Promise.all(ids.slice(1).map((id) => readEvents(ctx, id)));
				return logs.every((log) => !log.some((event) => event.type === "compaction/summary"));
			}, 8000);
		}
	});
});

test("batch: a plugin-only unload leaves finished results, later items not started", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-unload-parent");
		const first = await settleTwoTurnChild(ctx, parent, fake);
		const second = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		fake.state.delayMs = 250;
		const run = ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		const start = fake.state.requests.length;
		await waitFor(() => fake.state.requests.length > start);
		await ctx.compactorFiber.dispose();
		const execution = await run;
		assert.notEqual(execution.result.kind, "success");
		assert.match(execution.result.text, /not-started: 1/);
		assert.match(execution.result.text, new RegExp(first));
		const secondLog = await readEvents(ctx, second);
		assert.equal(secondLog.filter((event) => event.type === "compaction/summary").length, 0, "the unloaded batch starts nothing new");
	});
});

test("batch: concurrent single compaction of a batch target reports busy", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-race-parent");
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		fake.state.delayMs = 300;
		const batch = ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		await waitFor(() => fake.state.requests.some((request) => request.mode === "summarize"));
		const single = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(single.result.kind, "error");
		assert.match(single.result.text, /already in progress/);
		fake.state.delayMs = 0;
		const done = await batch;
		assert.equal(done.result.kind, "success");
	});
});

test("batch: empty catalog is explicit; --all rejects extra arguments", async () => {
	await withComposition(async (ctx) => {
		const parent = await makeParent(ctx, "batch-empty-parent");
		const execution = await ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		assert.equal(execution.result.kind, "success");
		assert.match(execution.result.text, /no direct subagents/i);
		const mixed = await ctx.commands.execute(parent, "/subagent-compact --all extra", [], signal());
		assert.equal(mixed.result.kind, "error");
		assert.match(mixed.result.text, /Usage/);
	});
});

test("batch: children spawned during the run are not added to the snapshot", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx, "batch-snapshot-parent");
		const first = await settleTwoTurnChild(ctx, parent, fake);
		fake.state.mode = "summarize";
		fake.state.delayMs = 300;
		const run = ctx.commands.execute(parent, "/subagent-compact --all", [], signal());
		const start = fake.state.requests.length;
		await waitFor(() => fake.state.requests.length > start);
		// A brand-new child finishes (and settles) while the batch is mid-summary.
		const late = await settleChild(ctx, parent, "Spawned mid-batch", { agentOptions: { provider: PROVIDER, model: CHILD_MODEL } });
		await waitFor(() => ctx.agents.get(late) === undefined);
		const execution = await run;
		assert.equal(execution.result.kind, "success", execution.result.text);
		assert.match(execution.result.text, /total 1/);
		assert.doesNotMatch(execution.result.text, new RegExp(late), "the late child belongs to the NEXT run, not this snapshot");
		const lateLog = await readEvents(ctx, late);
		assert.equal(lateLog.filter((event) => event.type === "compaction/summary").length, 0, "the late child was not compacted by this run");
		void first;
	});
});
