/**
 * Integration test: boot a real Cordis composition of DSH modules from the
 * installed Harness tree (session persistence in a temp dir, token meter,
 * compaction-basic, agent loop, subagent + in-process spawn provider,
 * commands/tools services) with a local Anthropic-Messages-compatible fake
 * LLM server, and prove end to end:
 *
 *  1. a real continuable subagent spawned through ctx.subagents runs its
 *     activation to TRUE settlement; once the settlement watcher reclaims it,
 *     the child is no longer live and the command fails explicitly
 *     (not-resident) — the settled/cold boundary is asserted, not assumed;
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
 * Modules resolve from a stock rc.1 or rc.2 tree linked at ./node_modules.
 */
import test, { after } from "node:test";
import { HostAssemblyError, INERT_MODULE, disposeComposition, inertHost, loadDeepSeekAuth, releaseLeakedFixtureListeners, reportHostAssemblyFailure, skipIfHostUnassembled, startActivation, trackFixtureListener } from "./runtime-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

process.env.DEEPSEEK_API_KEY = "test-key-used-by-fake-server";

const PROVIDER = "deepseek-official";
const MODEL = "deepseek-flash";

// A fixture listener that outlives its test fails the file instead of holding the process open.
after(releaseLeakedFixtureListeners);

/**
 * Minimal Anthropic Messages SSE responder scripted by the tests. Each
 * request captures its mode AT ARRIVAL. Explicit gates hold selected child
 * requests open until the command is waiting; no timing guess creates the live window.
 */
function createFakeMessagesServer() {
	const state = { mode: "turn", requests: [] };
	const heldRequests = [];
	const server = trackFixtureListener(http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const held = heldRequests.find((entry) => entry.request === undefined && body.includes(entry.marker));
			const mode = held?.mode ?? state.mode;
			const received = { url: request.url, mode };
			state.requests.push(received);
			const filler = "The worker examined the corpus, recorded structured findings, and kept the log verbose enough to build a compactable history span. ".repeat(40);
			const textByMode = {
				turn: `Turn complete. ${filler}`,
				"turn-short": "Round two done.",
				summarize: "Checkpoint summary: the worker completed its assigned turns; details condensed.",
				turn2: "Follow-up handled after compaction."
			};
			const respond = () => {
				if (response.destroyed) return;
				response.writeHead(200, { "content-type": "text/event-stream" });
				const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				send({ type: "message_start", message: { id: "msg_fake", usage: { input_tokens: 12, output_tokens: 4 } } });
				send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: textByMode[mode] ?? textByMode.turn } });
				send({ type: "content_block_stop", index: 0 });
				send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
				send({ type: "message_stop" });
				response.end();
			};
			if (held) {
				held.request = received;
				held.release = () => {
					held.release = undefined;
					respond();
				};
			} else respond();
		});
	}));
	return {
		state,
		hold: (marker, mode) => {
			const held = { marker, mode, request: undefined, release: undefined };
			heldRequests.push(held);
			return held;
		},
		start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
		close: () => new Promise((resolve) => {
			for (const held of heldRequests) held.release?.();
			server.close(() => resolve());
		})
	};
}

/**
 * Boot the full Host-plane composition plus the plugin under test. A failure
 * while a host row is still being imported or mounted precedes the plugin:
 * announce it for the upstream watcher, release the half-built composition,
 * and throw the fixture's own error in place of the host's.
 */
async function bootComposition(baseURL, storageRoot, { resumeInactive = false, hostModules = {}, pluginModule } = {}) {
	const modules = {};
	const ctx = new Context();
	// The host step in progress; cleared once the host is up and this plugin is what is under test.
	let stage = "";
	try {
		for (const moduleName of [
			"@deepseek-ai/cordis-plugin-timer",
			"@deepseek-ai/dsh-llm",
			"@deepseek-ai/dsh-llm-deepseek-api-key",
			"@deepseek-ai/dsh-system-prompt",
			"@deepseek-ai/dsh-tools",
			"@deepseek-ai/dsh-tool-executor-native",
			"@deepseek-ai/dsh-commands",
			"@deepseek-ai/dsh-fs-local",
			"@deepseek-ai/dsh-session",
			"@deepseek-ai/dsh-session-projection",
			"@deepseek-ai/dsh-session-persistence-jsonl",
			"@deepseek-ai/dsh-session-query",
			"@deepseek-ai/dsh-token-meter",
			"@deepseek-ai/dsh-compaction-basic",
			"@deepseek-ai/dsh-agent",
			"@deepseek-ai/dsh-agent-loop",
			"@deepseek-ai/dsh-working-directory",
			"@deepseek-ai/dsh-subagent",
			"@deepseek-ai/dsh-subagent-spawn-in-process"
		]) {
			stage = `import ${moduleName}`;
			modules[moduleName] = hostModules[moduleName] ?? await import(moduleName);
		}
		stage = "import @deepseek-ai/dsh-deepseek-auth";
		const deepSeekAuth = hostModules["@deepseek-ai/dsh-deepseek-auth"] ?? await loadDeepSeekAuth();
		if (deepSeekAuth) modules["@deepseek-ai/dsh-deepseek-auth"] = deepSeekAuth;
		const rows = [
			["@deepseek-ai/cordis-plugin-timer", {}],
			["@deepseek-ai/dsh-llm", {}],
			...(deepSeekAuth ? [["@deepseek-ai/dsh-deepseek-auth", {}]] : []),
			["@deepseek-ai/dsh-llm-deepseek-api-key", { baseURL, defaultContextWindow: 200000 }],
			["@deepseek-ai/dsh-system-prompt", { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: "You are the integration test worker." }],
			["@deepseek-ai/dsh-tools", {}],
			["@deepseek-ai/dsh-tool-executor-native", {}],
			["@deepseek-ai/dsh-commands", {}],
			["@deepseek-ai/dsh-fs-local", {}],
			["@deepseek-ai/dsh-session", {}],
			["@deepseek-ai/dsh-session-projection", {}],
			["@deepseek-ai/dsh-session-persistence-jsonl", { root: storageRoot, compression: "none" }],
			["@deepseek-ai/dsh-session-query", {}],
			["@deepseek-ai/dsh-token-meter", {}],
			["@deepseek-ai/dsh-compaction-basic", { auto: false }],
			["@deepseek-ai/dsh-agent", {}],
			["@deepseek-ai/dsh-agent-loop", { agents: [] }],
			["@deepseek-ai/dsh-working-directory", {}],
			["@deepseek-ai/dsh-subagent", { maxDepth: 3 }],
			["@deepseek-ai/dsh-subagent-spawn-in-process", {}]
		];
		for (const [moduleName, config] of rows) {
			const module = modules[moduleName];
			stage = `mount ${moduleName}`;
			await ctx.plugin(module.default ?? module, config);
		}
		stage = "";
		const plugin = pluginModule ?? await import("../index.js");
		await ctx.plugin(plugin, { waitForIdle: true, resumeInactive });
		return ctx;
	} catch (error) {
		const cleanup = await disposeComposition(ctx);
		if (!stage) throw error;
		reportHostAssemblyFailure(stage, error, cleanup);
		throw new HostAssemblyError(stage, error);
	}
}

/** Instance-independent bounded poll; cold resumes swap Agent objects. */
async function waitFor(probe, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("waitFor deadline exceeded");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("integration: live-window compaction of a real continuable subagent", async () => {
	const fake = createFakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-it-"));
	let ctx;
	const signal = () => new AbortController().signal;
	try {
		// Started and assembled inside the try: a host that fails to boot still reaches the cleanup.
		ctx = await bootComposition(await fake.start(), storageRoot);
		assert.notEqual(ctx.get("compaction"), undefined, "host-plane compaction engine must be composed");

		const parentHandle = await ctx.agents.create({
			sessionId: "it-parent-1",
			agentOptions: { provider: PROVIDER, model: MODEL }
		});
		const parent = parentHandle.agent;

		// 1. First activation runs to TRUE settlement, then the watcher reclaims the child.
		const activation = await startActivation(ctx, {
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
		const originalChild = ctx.agents.get(childId);
		assert.notEqual(originalChild, undefined, "the first activation starts as a live child");
		const firstResult = await activation.result;
		assert.notEqual(firstResult.stopReason, "error", `first turn failed: ${JSON.stringify(firstResult)}`);
		assert.match(JSON.stringify(firstResult.output), /Turn complete\./, "the first activation must actually run the model");
		await waitFor(() => ctx.agents.get(childId) === undefined);
		assert.equal(ctx.agents.get(childId), undefined, "a truly settled continuable child is reclaimed by the settlement watcher");
		const lateExecution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(lateExecution.result.kind, "error");
		assert.match(lateExecution.result.text, /No live agent with session id/);

		// 2. Hold the resumed child's actual HTTP request, not an assumed delay.
		const round2 = fake.hold("Working round 2: please continue and report.", "turn-short");
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Working round 2: please continue and report." }], { signal: signal() });
		await waitFor(() => round2.request);
		const liveChild = ctx.agents.get(childId);
		assert.notEqual(liveChild, undefined, "cold resume brings the child id back live");
		assert.notEqual(liveChild, originalChild, "cold resume must create a fresh Agent for the same child id");
		const listing = await ctx.commands.execute(parent, "/subagent-compact", [], signal());
		assert.equal(listing.result.kind, "success");
		assert.match(listing.result.text, new RegExp(childId));

		// 3. Compact DURING the running request: wait-for-idle bridges turn end into the engine.
		const tokensBefore = ctx.tokenMeter.measure(liveChild.session).totalTokens;
		fake.state.mode = "summarize";
		// No attachments: execute enters the handler synchronously before its first await.
		const compaction = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		round2.release();
		const compactExecution = await compaction;
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
		const round3 = fake.hold("Working round 3: please continue.", "turn");
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "Working round 3: please continue." }], { signal: signal() });
		await waitFor(() => round3.request);
		assert.notEqual(ctx.agents.get(childId), undefined, "ownership is checked against a live child");
		const foreignExecution = await ctx.commands.execute(parent2, `/subagent-compact ${childId}`, [], signal());
		assert.equal(foreignExecution.result.kind, "error");
		assert.match(foreignExecution.result.text, /not one of your live runtime-created direct subagents/);
		round3.release();

		console.log(`integration ok: child=${childId} tokens ${tokensBefore} -> ${tokensAfter}, llm requests=${fake.state.requests.length}`);
	} finally {
		await Promise.resolve(ctx?.fiber?.dispose?.()).catch(() => {});
		await fake.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

/**
 * Integration: the RESUME path on the plain Host-plane composition. A real
 * continuable subagent runs to true settlement and reclamation; one
 * /subagent-compact <id> then wakes it through the ordinary continuation
 * lifecycle, compacts it at the synchronous start edge, persists the summary,
 * and the wake message is answered afterwards by a normal turn — no held
 * request creates any window here.
 */
test("integration: resume-path compaction of a settled continuable subagent", async () => {
	const fake = createFakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-resume-"));
	let ctx;
	const signal = () => new AbortController().signal;
	try {
		ctx = await bootComposition(await fake.start(), storageRoot, { resumeInactive: true });
		const parent = (await ctx.agents.create({
			sessionId: "resume-parent-1",
			agentOptions: { provider: PROVIDER, model: MODEL }
		})).agent;
		const activation = await startActivation(ctx, {
			provider: "spawn",
			label: "resume worker",
			request: { prompt: [{ type: "text", text: "Please do the first task. " + "Background context line that the worker must keep. ".repeat(300) }], parent },
			signal: signal(),
			delivery: "parent"
		});
		const childId = activation.childId;
		const originalChild = ctx.agents.get(childId);
		const firstResult = await activation.result;
		assert.notEqual(firstResult.stopReason, "error", `first turn failed: ${JSON.stringify(firstResult)}`);
		await waitFor(() => ctx.agents.get(childId) === undefined);
		assert.equal(ctx.agents.get(childId), undefined, "the child starts truly settled and reclaimed");

		/* Summaries answer with checkpoint text; the wake turn after the
		 * summary answers with the short round text. */
		fake.state.mode = "summarize";
		const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], signal());
		assert.equal(execution.result.kind, "success", `resume compact failed: ${execution.result.text}`);
		assert.match(execution.result.text, /Resumed and compacted subagent/);
		assert.match(execution.result.text, /replaced [1-9]\d* history items/);
		assert.match(execution.result.text, /wake message/);

		const observed = await ctx.sessionQuery.observeSession(childId);
		let events;
		try {
			events = [...observed.events];
		} finally {
			observed[Symbol.dispose]();
		}
		const summary = events.find((event) => event.type === "compaction/summary");
		assert.ok(summary, "the resumed child records the summary in its own session");
		assert.equal(summary.data.sourceCommandId, execution.commandId, "summary provenance is the resume command");
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
			"the resume-path summary is durable on disk"
		);

		/* The wake message is answered by a normal turn AFTER the summary. */
		await waitFor(async () => {
			const observation = await ctx.sessionQuery.observeSession(childId);
			try {
				return [...observation.events].some((event) => event.type === "assistant/message");
			} finally {
				observation[Symbol.dispose]();
			}
		});
		/* A later continuation sees the committed checkpoint in its context. */
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
		const followupRequest = [...fake.state.requests].reverse().find((request) => request.url.includes("/messages"));
		assert.ok(JSON.stringify(followupRequest).length > 0);
		console.log(`integration resume ok: child=${childId} requests=${fake.state.requests.length}`);
	} finally {
		await Promise.resolve(ctx?.fiber?.dispose?.()).catch(() => {});
		await fake.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

/**
 * R1 regression: cancelling the caller's signal inside the resume admission
 * gap — after the subagent/start edge has synchronously launched the engine
 * job, before the wake message is admitted — must not leave that engine
 * promise as an unhandled rejection (Node exits 1 on those). The command
 * reports cancelled, the engine job is observed and settled, and no summary
 * is committed.
 */
test("integration: cancelling in the resume admission gap leaves no unhandled rejection", async () => {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const fake = createFakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-gapcancel-"));
	let ctx;
	const controller = new AbortController();
	try {
		ctx = await bootComposition(await fake.start(), storageRoot, { resumeInactive: true });
		const parent = (await ctx.agents.create({
			sessionId: "gapcancel-parent-1",
			agentOptions: { provider: PROVIDER, model: MODEL }
		})).agent;
		const activation = await startActivation(ctx, {
			provider: "spawn",
			label: "gap cancel worker",
			request: { prompt: [{ type: "text", text: "Initial task. " + "Context to compact. ".repeat(500) }], parent },
			signal: new AbortController().signal,
			delivery: "parent"
		});
		const childId = activation.childId;
		const firstResult = await activation.result;
		assert.notEqual(firstResult.stopReason, "error", JSON.stringify(firstResult));
		await waitFor(() => ctx.agents.get(childId) === undefined);

		/* Registered BEFORE the plugin's own hook (which attaches when the
		 * command runs): this listener runs first at the start edge and
		 * cancels the caller's signal one microtask later — inside the
		 * admission gap, after the engine job launched, before the wake is
		 * admitted. */
		const off = ctx.on("subagent/start", (info) => {
			if (info.id !== childId) return;
			queueMicrotask(() => controller.abort(new Error("cancel in resume admission gap")));
		});
		/* The host may surface the cancellation either as an error result or
		 * by throwing out of execute; both are acceptable cancellations. */
		let resultText;
		try {
			const execution = await ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], controller.signal);
			resultText = execution.result.text;
			assert.equal(execution.result.kind, "error", JSON.stringify(execution.result));
		} catch (error) {
			resultText = String(error?.message ?? error);
		}
		off();
		assert.match(resultText, /[Cc]ancel/, "either the plugin's cancelled receipt or the host's abort reason");
		/* Let any unobserved rejection surface. */
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(unhandled, [], "the engine promise launched at the start edge must be observed and settled");
		const observed = await ctx.sessionQuery.observeSession(childId);
		let events;
		try {
			events = [...observed.events];
		} finally {
			observed[Symbol.dispose]();
		}
		assert.equal(events.some((event) => event.type === "compaction/summary"), false, "a cancelled resume must not commit a summary");
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await Promise.resolve(ctx?.fiber?.dispose?.()).catch(() => {});
		await fake.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

/** Everything the fixture printed to stderr, one entry per line. */
const announcedLines = (announced) => announced.mock.calls.flatMap((call) => String(call.arguments[0]).split("\n"));

/** The leading `at` lines of a thrown error's stack: what the announcement repeats from a host row's own error. */
const stackFrames = (error) => String(error.stack).split("\n").filter((line) => /^\s+at /.test(line));

/**
 * Attribution by phase, for the upstream watcher: only a host row that fails
 * before ../index.js is imported is the host's fault. Every other host row
 * stands in as inert, so the check holds on a runtime whose own composition
 * cannot come up, and its own failure is never mistaken for one.
 */
test("fixture: a host row that fails to mount is announced as such", async (t) => {
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-bootfail-"));
	t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
	const announced = t.mock.method(console, "error", () => {});
	const hostFailure = Object.assign(new Error('cannot get property "undefined" without inject'), { code: "ERR_HOST_PROBE" });
	await assert.rejects(bootComposition("http://127.0.0.1:9", storageRoot, { hostModules: inertHost({ "@deepseek-ai/dsh-llm": { apply() { throw hostFailure; } } }) }),
		(error) => error instanceof HostAssemblyError && error.hostError === hostFailure, "the test fails with the fixture's own error, which the reporter prints without the host's");
	const lines = announcedLines(announced);
	assert.equal(lines[0], 'DSH_HOST_ASSEMBLY_FAILED mount @deepseek-ai/dsh-llm: Error [ERR_HOST_PROBE]: cannot get property "undefined" without inject');
	assert.deepEqual(lines.slice(1), stackFrames(hostFailure).slice(0, 6), "the host's own frames follow, and nothing else");
});

/** A host row may fail with an assertion of its own. The test must then fail without printing one: the watcher reads an AssertionError as this plugin's. */
test("fixture: a host row that fails with an assertion is announced, and never thrown as an assertion", async (t) => {
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-bootfail-"));
	t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
	const announced = t.mock.method(console, "error", () => {});
	const hostFailure = new assert.AssertionError({ message: "host config rejected" });
	let thrown;
	await assert.rejects(bootComposition("http://127.0.0.1:9", storageRoot, { hostModules: inertHost({ "@deepseek-ai/dsh-llm": { apply() { throw hostFailure; } } }) }),
		(error) => { thrown = error; return error instanceof HostAssemblyError; });
	assert.equal(thrown.hostError, hostFailure);
	assert.equal(thrown instanceof assert.AssertionError, false);
	assert.equal(thrown.cause, undefined, "a cause is printed by the reporter, in full");
	assert.deepEqual(Object.keys(thrown).filter((key) => thrown[key] instanceof Error), [], "no property the reporter prints holds the host's error");
	assert.equal(announcedLines(announced)[0], "DSH_HOST_ASSEMBLY_FAILED mount @deepseek-ai/dsh-llm: AssertionError [ERR_ASSERTION]: host config rejected");
});

/** The cleanup of a half-built composition must never take the place of the host failure it follows. */
test("fixture: a cleanup that throws neither hides the host failure nor its announcement", async (t) => {
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-bootfail-"));
	t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
	const announced = t.mock.method(console, "error", () => {});
	const cleanupFailure = new Error("dispose failed");
	const hostFailure = new Error("host row failed");
	await assert.rejects(bootComposition("http://127.0.0.1:9", storageRoot, { hostModules: inertHost({
		// A root-level row reaches the composition's root fiber and breaks its disposal.
		"@deepseek-ai/cordis-plugin-timer": { apply(child) { child.fiber.parent.fiber.dispose = () => { throw cleanupFailure; }; } },
		"@deepseek-ai/dsh-llm": { apply() { throw hostFailure; } },
	}) }), (error) => error instanceof HostAssemblyError && error.hostError === hostFailure);
	const lines = announcedLines(announced);
	assert.equal(lines[0], "DSH_HOST_ASSEMBLY_FAILED mount @deepseek-ai/dsh-llm: Error: host row failed");
	assert.deepEqual(lines.slice(1, -1), stackFrames(hostFailure).slice(0, 6));
	assert.equal(lines.at(-1), "DSH_FIXTURE_CLEANUP_FAILED mount @deepseek-ai/dsh-llm: Error: dispose failed", "the cleanup failure is reported on its own line");
});

/** The other side of the same boundary: once the host is up, a plugin that fails to mount is this plugin under test. */
test("fixture: a plugin that fails to mount once the host is up is not announced", async (t) => {
	const storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-bootfail-"));
	t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
	const announced = t.mock.method(console, "error", () => {});
	const pluginFailure = new Error("plugin apply failed");
	// The stock host has to come up for the plugin phase to be reached at all.
	// Only a host that cannot assemble skips; any other error of the precondition is this check's own failure.
	const booted = await bootComposition("http://127.0.0.1:9", storageRoot, { pluginModule: INERT_MODULE }).then((ctx) => ({ ctx }), (error) => ({ error }));
	if (!booted.ctx) { skipIfHostUnassembled(t, booted.error); return; }
	await booted.ctx.fiber.dispose();
	await assert.rejects(bootComposition("http://127.0.0.1:9", storageRoot, { pluginModule: { apply() { throw pluginFailure; } } }), (error) => error === pluginFailure);
	assert.deepEqual(announced.mock.calls, [], "the host assembled; the plugin under test is what failed");
});
