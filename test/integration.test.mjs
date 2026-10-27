/**
 * Integration test: boot a real Cordis composition of DSH modules from the
 * installed Harness tree (session persistence in a temp dir, token meter,
 * compaction-basic, agent loop, subagent + in-process spawn provider,
 * commands/tools services) with a local Anthropic-Messages-compatible fake
 * LLM server, and prove the LIVE-window journey end to end:
 *
 *  1. a real continuable subagent spawned through ctx.subagents runs its
 *     activation to TRUE settlement; the settlement watcher reclaims the
 *     child (asserted, not assumed). The follow-up invocation of a settled
 *     child id is covered by the cold suite (cold.integration.test.mjs).
 *  2. re-waking the same child by id (sendMessage cold-resumes it from
 *     persistence as a fresh live agent) and invoking /subagent-compact while
 *     that real request is RUNNING takes the deterministic live window: the
 *     plugin waits for the turn to end, the real engine compacts the child's
 *     session, and the jsonl persistence records the summary;
 *  3. after compaction the child still accepts and answers a later message;
 *     waiting is instance-independent (polling the session log), because a
 *     cold resume may have replaced the Agent object;
 *  4. a different parent cannot compact someone else's child.
 *
 * Modules resolve from a DSH 0.2.1-rc.2 tree linked at ./node_modules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootComposition, createFakeMessagesServer, waitFor, PROVIDER, MODEL } from "./helpers.mjs";

test("integration: live-window compaction of a real continuable subagent", async () => {
	const fake = createFakeMessagesServer();
	const baseURL = await fake.start();
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-it-"));
	const ctx = await bootComposition(baseURL, storageRoot);
	const signal = () => new AbortController().signal;
	try {
		assert.notEqual(ctx.get("compaction"), undefined, "host-plane compaction engine must be composed");

		const parentHandle = await ctx.agents.create({
			sessionId: "it-parent-1",
			agentOptions: { provider: PROVIDER, model: MODEL }
		});
		const parent = parentHandle.agent;

		// 1. First activation runs to TRUE settlement, then the watcher reclaims the child.
		const activation = await ctx.subagents.startActivation({
			provider: "spawn",
			label: "integration worker",
			request: {
				prompt: [{ type: "text", text: "Please do the first task." }],
				parent
			},
			signal: signal(),
			delivery: "parent"
		});
		const childId = activation.childId;
		await activation.result;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(ctx.agents.get(childId), undefined, "a truly settled continuable child is reclaimed by the settlement watcher");

		// 2. Re-wake the same child id: cold resume as a fresh live agent running a slow, SHORT turn.
		fake.state.mode = "turn-short";
		fake.state.delayMs = 400;
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Working round 2: please continue and report." }], { signal: signal() });
		const liveChild = await waitFor(() => ctx.agents.get(childId));
		assert.notEqual(liveChild, undefined, "cold resume brings the child id back live");
		await new Promise((resolve) => setTimeout(resolve, 80));
		const listing = await ctx.commands.execute(parent, "/subagent-compact", [], signal());
		assert.equal(listing.result.kind, "success");
		assert.match(listing.result.text, new RegExp(childId));

		// 3. Compact DURING the running request: wait-for-idle bridges turn end into the engine.
		const tokensBefore = ctx.tokenMeter.measure(liveChild.session).totalTokens;
		fake.state.delayMs = 0;
		fake.state.mode = "summarize";
		const compactExecution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(compactExecution.result.kind, "success", `compact failed: ${compactExecution.result.text}`);
		assert.match(compactExecution.result.text, /Compacted subagent/);
		assert.match(compactExecution.result.text, /replaced [1-9]\d* history items/, "the replaced span must be non-empty");
		const tokensAfter = ctx.tokenMeter.measure(liveChild.session).totalTokens;
		assert.ok(tokensAfter < tokensBefore, `surface must shrink: before=${tokensBefore} after=${tokensAfter}`);

		// 4. Compaction events in the child session + persistence on disk.
		const observed = await ctx.sessionQuery.observeSession(childId);
		let events;
		try {
			events = [...observed.events];
		} finally {
			observed[Symbol.dispose]();
		}
		assert.equal(events.filter((event) => event.type === "compaction/summary").length, 1, "exactly one compaction/summary event");
		const endEvents = events.filter((event) => event.type === "compaction/end");
		assert.equal(endEvents.length, 1, "exactly one compaction/end event");
		assert.equal(endEvents[0].data.error, undefined, "compaction/end must not carry an error");
		const persisted = [];
		const visit = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const full = join(directory, entry.name);
				if (entry.isDirectory()) visit(full);
				else if (entry.name.endsWith(".jsonl")) persisted.push(readFileSync(full, "utf8"));
			}
		};
		visit(storageRoot);
		assert.notEqual(
			persisted.find((content) => content.includes(childId) && content.includes("compaction/summary")),
			undefined,
			"child jsonl must persist the compaction events"
		);

		// 5. The child stays usable after compaction; wait on the session log, not the old handle.
		fake.state.mode = "turn2";
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Please handle the follow-up." }], { signal: signal() });
		await waitFor(async () => {
			const observation = await ctx.sessionQuery.observeSession(childId);
			try {
				return [...observation.events].some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("Follow-up handled after compaction."));
			} finally {
				observation[Symbol.dispose]();
			}
		});

		// 6. Another parent cannot compact this child — tested inside a live
		// window (round 3 mid-turn) so the rejection exercises ownership, not
		// residency.
		const parent2 = (await ctx.agents.create({
			sessionId: "it-parent-2",
			agentOptions: { provider: PROVIDER, model: MODEL }
		})).agent;
		fake.state.mode = "turn";
		fake.state.delayMs = 400;
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Working round 3: please continue." }], { signal: signal() });
		await waitFor(() => ctx.agents.get(childId) !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 60));
		const foreignExecution = await ctx.commands.execute(parent2, `/subagent-compact ${childId}`, [], signal());
		assert.equal(foreignExecution.result.kind, "error");
		assert.match(foreignExecution.result.text, /not one of your (live )?runtime-created direct subagents|belongs to another parent session/);
		fake.state.delayMs = 0;

		console.log(`integration ok: child=${childId} tokens ${tokensBefore} -> ${tokensAfter}, llm requests=${fake.state.requests.length}`);
	} finally {
		await Promise.resolve(ctx.fiber?.dispose?.()).catch(() => {});
		await fake.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});
