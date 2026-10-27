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

test("cold: concurrent sends during the maintenance window fail before acceptance; retry is delivered once", async () => {
	await withComposition(async (ctx, fake) => {
		const parent = await makeParent(ctx);
		const childId = await settleTwoTurnChild(ctx, parent, fake);
		assert.equal(ctx.agents.get(childId), undefined);

		// Slow summary so the window is observably open.
		fake.state.mode = "summarize";
		fake.state.delayMs = 300;
		const requestsBefore = fake.state.requests.length;
		const executionPromise = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());

		// Wait until the summary request is in flight — the plugin then holds
		// the persistence writer for sure (resume finished, engine running).
		await waitFor(() => fake.state.requests.length > requestsBefore);
		const midWindowSends = [];
		for (let index = 0; index < 3; index += 1) {
			midWindowSends.push(
				ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: `Concurrent ${index}: should not be silently swallowed.` }], { signal: signal() })
					.then((value) => ({ accepted: true, value }), (error) => ({ accepted: false, error }))
			);
		}
		const midResults = await Promise.all(midWindowSends);
		const acceptedMid = midResults.filter((result) => result.accepted);
		// The write-lock boundary must reject competing sends BEFORE
		// acceptance; a false success here is the failure mode this test
		// exists to catch.
		assert.equal(acceptedMid.length, 0, "no competing send may be accepted while the cold writer is held");
		for (const result of midResults) {
			assert.ok(result.error instanceof Error);
			assert.match(result.error.message, /unavailable|resumable|owned|busy/i, `clean failure expected, got: ${result.error.message}`);
		}

		const execution = await executionPromise;
		assert.equal(execution.result.kind, "success", `cold compact failed: ${execution.result.text}`);

		// After release, a retried send is accepted and delivered exactly once.
		fake.state.delayMs = 0;
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Retry after the window: please respond." }], { signal: signal() });
		await waitFor(async () => {
			const log = await readEvents(ctx, childId);
			return log.some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
		}, 8000);
		const log = await readEvents(ctx, childId);
		const userTexts = log.filter((event) => event.type === "user/message").map((event) => JSON.stringify(event.data));
		for (let index = 0; index < 3; index += 1) {
			assert.equal(userTexts.filter((text) => text.includes(`Concurrent ${index}:`)).length, 0, `rejected send ${index} must not appear in the log`);
		}
		assert.equal(userTexts.filter((text) => text.includes("Retry after the window")).length, 1, "retried send delivered exactly once");
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
