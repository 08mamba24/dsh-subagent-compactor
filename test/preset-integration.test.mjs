/**
 * Official Desktop 0.2.2's bundled Harness 0.2.2-rc.1 preset acceptance,
 * using only a loopback LLM and temporary JSONL storage. Resolve dependencies from an isolated scratch
 * package linked to the extracted official app tree; no installed profile,
 * credentials service, or user configuration is loaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Group, Loader } from "@deepseek-ai/cordis-plugin-loader";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";

const PROVIDER = "deepseek-official";
const MODEL = "deepseek-flash";
const PRESET = "isolated-test-preset";
const TEST_KEY_ENV = "DSH_PRESET_TEST_FAKE_API_KEY";
process.env[TEST_KEY_ENV] = "loopback-only-test-key";

function deadline(promise, label, timeoutMs = 15_000) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
		})
	]).finally(() => clearTimeout(timer));
}

/** Replayable event observation closes the subscribe/check race without polling. */
function sessionJournal(ctx) {
	const entries = [];
	const pending = new Set();
	const dispose = ctx.on("session/event", (session, event) => {
		const entry = { sessionId: session.id, event };
		entries.push(entry);
		for (const waiter of pending) if (waiter.matches(entry)) waiter.resolve(entry);
	});
	return {
		entries,
		async wait(matches, label) {
			const found = entries.find(matches);
			if (found !== undefined) return found;
			const result = Promise.withResolvers();
			const waiter = { matches, resolve: result.resolve };
			pending.add(waiter);
			try {
				return await deadline(result.promise, label);
			} finally {
				pending.delete(waiter);
			}
		},
		dispose
	};
}

/** One request gate is released by the test after real HTTP admission. */
function fakeMessagesServer() {
	const gates = [];
	const requests = [];
	const sockets = new Set();
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const lastInput = JSON.stringify(body.messages.at(-1));
			const summarizing = lastInput.includes("acting as a compaction engine");
			const received = { url: request.url, body, summarizing };
			requests.push(received);
			const gate = gates.find((entry) => !summarizing && !entry.received && lastInput.includes(entry.marker));
			const respond = () => {
				if (response.destroyed) return;
				const text = summarizing
					? "Checkpoint: completed the corpus review; continue the same assigned task."
					: lastInput.includes("AFTER_COMPACTION")
						? "Same child continued after the checkpoint."
						: lastInput.includes("SECOND_NATIVE_TURN")
							? "Native second turn completed."
							: "The worker recorded durable findings and traced each observation to its source. ".repeat(40);
				response.writeHead(200, { "content-type": "text/event-stream" });
				const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				send({ type: "message_start", message: { id: `fake-${requests.length}`, usage: { input_tokens: 12, output_tokens: 4 } } });
				send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
				send({ type: "content_block_stop", index: 0 });
				send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
				send({ type: "message_stop" });
				response.end();
			};
			if (gate) {
				gate.received = true;
				gate.release = respond;
				gate.arrived.resolve(received);
			} else respond();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return {
		requests,
		hold(marker, respondDelayMs = 0) {
			const gate = { marker, arrived: Promise.withResolvers(), received: false };
			gates.push(gate);
			return {
				arrived: () => deadline(gate.arrived.promise, `HTTP ${marker}`),
				release: () => {
					assert.ok(gate.release, `request ${marker} must arrive first`);
					/* A delayed response keeps the child's turn in flight across
					 * macrotask boundaries (used by the batch test to keep a later
					 * child mid-request until the serial batch parks on it). */
					setTimeout(gate.release, respondDelayMs);
				}
			};
		},
		async start() {
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			return `http://127.0.0.1:${server.address().port}`;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		}
	};
}

async function boot(baseURL, storageRoot, { plugin, auto }) {
	const ctx = new Context();
	try {
		await ctx.plugin(Loader, { baseUrl: new URL("../package.json", import.meta.url).href });
		// app-boot publishes the same native Loader builtin before loading rows.
		ctx.loader.builtins.group = Group;
		const rows = [
			["cordis-plugin-timer", {}],
			["dsh-llm", {}],
			["dsh-llm-deepseek-api-key", { baseURL, apiKeyEnv: TEST_KEY_ENV, models: [{ id: MODEL, contextWindow: auto ? 4000 : 200000 }] }],
			["dsh-system-prompt", { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: "You are a test worker." }],
			["dsh-tools", {}],
			["dsh-tool-executor-native", {}],
			["dsh-commands", {}],
			["dsh-fs-local", {}],
			["dsh-session", {}],
			["dsh-session-projection", {}],
			["dsh-session-persistence-jsonl", { root: storageRoot, compression: "none" }],
			["dsh-session-query", {}],
			["dsh-token-meter", {}],
			["dsh-agent", {}],
			["dsh-agent-loop", { agents: [] }],
			["dsh-working-directory", {}],
			["dsh-subagent", {}],
			["dsh-subagent-spawn-in-process", {}],
			["dsh-agent-preset-registry", { default: PRESET }]
		];
		for (const [name, config] of rows) {
			const module = await import(`@deepseek-ai/${name}`);
			await ctx.plugin(module.default ?? module, config);
		}
		// Same group shape as official dsh-web-app/presets/minimal.patch.yml.
		await ctx.loader.root.update([{
			id: "preset-test", name: "@deepseek-ai/dsh-agent-preset",
			config: {
				id: PRESET,
				plugins: [{
					id: "compaction", name: "cordis:group", group: true,
					isolate: { compaction: true },
					config: [
						{ id: "engine", name: "@deepseek-ai/dsh-compaction-basic", config: { auto, headroomTokens: 0, maxTokens: 256, retainRatio: 0.1 } },
						{ id: "native-command", name: "@deepseek-ai/dsh-command-compact" }
					]
				}]
			}
		}]);
		await ctx.loader.await();
		assert.deepEqual(await ctx.agentPresets.resolve(PRESET), { id: PRESET });
		if (plugin) await ctx.plugin(await import("../index.js"), { waitForIdle: true });
		return ctx;
	} catch (error) {
		await ctx.fiber.dispose();
		throw error;
	}
}

function assertPreset(ctx, parent, child) {
	assert.equal(ctx.get("compaction"), undefined, "Host does not publish the isolated engine");
	assert.equal(child.ctx.get("compaction"), undefined, "Agent context still resolves the Host realm");
	assert.equal(ctx.agentPresets.composedPreset(parent.ctx), PRESET);
	assert.equal(ctx.agentPresets.composedPreset(child.ctx), PRESET, "spawn inherits the parent's retained preset");
	const engine = ctx.agentPresets.serviceFor(child, "compaction");
	assert.ok(engine instanceof BasicCompactionEngine, "serviceFor reaches the actual official engine");
	assert.ok(ctx.agentPresets.serviceFor(parent, "compaction") instanceof BasicCompactionEngine);
	return engine;
}

async function createParent(ctx, id) {
	return (await ctx.agents.create({
		sessionId: id,
		meta: { agentPreset: PRESET },
		agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 256 },
		setup: (agentCtx) => ctx.agentPresets.mount(agentCtx, PRESET).then(() => undefined)
	})).agent;
}

function persistedEvents(root, childId) {
	const events = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name.endsWith(".jsonl")) {
				const text = readFileSync(path, "utf8");
				if (text.includes(childId)) events.push(...text.trim().split("\n").map((line) => JSON.parse(line)));
			}
		}
	};
	visit(root);
	return events;
}

test("preset: real /subagent-compact persists a summary and resumes the same child id", { timeout: 30_000 }, async () => {
	const fake = fakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "dsh-preset-manual-"));
	const baseURL = await fake.start();
	let ctx;
	let journal;
	try {
		ctx = await boot(baseURL, storageRoot, { plugin: true, auto: false });
		journal = sessionJournal(ctx);
		const parent = await createParent(ctx, "preset-manual-parent");
		const first = fake.hold("FIRST_MANUAL_TURN");
		const activation = await ctx.subagents.startActivation({
			provider: "spawn", label: "preset worker", delivery: "parent",
			request: { parent, prompt: [{ type: "text", text: "FIRST_MANUAL_TURN: review the corpus. " + "Background context line that the worker must keep. ".repeat(300) }] },
			signal: AbortSignal.timeout(25_000)
		});
		activation.result.catch(() => {});
		await first.arrived();
		const childId = activation.childId;
		const child = ctx.agents.get(childId);
		assertPreset(ctx, parent, child);
		const command = ctx.commands.execute(parent, `/subagent-compact ${childId}`, [], AbortSignal.timeout(20_000));
		await journal.wait(({ sessionId, event }) => sessionId === parent.id && event.type === "command/run", "manual command admission");
		first.release();
		const execution = await deadline(command, "manual command result");
		assert.equal(execution.result.kind, "success", JSON.stringify(execution.result));
		assert.match(execution.result.text, /Compacted subagent/);
		const summary = journal.entries.find(({ sessionId, event }) => sessionId === childId && event.type === "compaction/summary")?.event;
		assert.ok(summary, "the child session records the real summary");
		assert.ok(summary.data.shadowedSeqs.length > 0);
		assert.equal(summary.data.sourceCommandId, execution.commandId, "summary provenance points to the actual parent command");
		assert.ok(persistedEvents(storageRoot, childId).some((event) => event.type === "compaction/summary"), "the command returns only after summary durability");
		const settled = await deadline(activation.result, "compacted child's settlement and teardown");
		assert.notEqual(settled.stopReason, "error", JSON.stringify(settled));
		assert.equal(ctx.agents.get(childId), undefined, "natural settlement reclaims the compacted child before cold resume");
		const followup = fake.hold("AFTER_COMPACTION");
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "AFTER_COMPACTION: continue the same task." }], { signal: AbortSignal.timeout(10_000) });
		const resumedRequest = await followup.arrived();
		const resumedChild = ctx.agents.get(childId);
		assert.equal(resumedChild.id, childId);
		assert.notEqual(resumedChild, child, "the same session id cold-resumes into a new Agent");
		assertPreset(ctx, parent, resumedChild);
		assert.ok(JSON.stringify(resumedRequest.body.messages).includes("completed the corpus review"), "continuation sees the landed checkpoint");
		followup.release();
		await journal.wait(({ sessionId, event }) => sessionId === childId && event.type === "assistant/message" && JSON.stringify(event.data).includes("Same child continued"), "same-id continuation response");
		assert.equal(fake.requests.filter((request) => request.summarizing).length, 1);
	} finally {
		journal?.dispose();
		await fake.close();
		await ctx?.fiber.dispose();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

/**
 * Drive the real preset composition through `/subagent-compact all` with two
 * live children whose held turns resolve in a configurable order. Whatever
 * the interleaving, both children must be compacted: the concurrent batch
 * parks on every child's idle wait before any turn ends, so a one-shot child
 * that settles first, last, or simultaneously is still caught inside its
 * live window. A serial batch fails the "child 2 settles first" and
 * "simultaneous" interleavings by arriving after child 2's reclamation.
 */
async function batchWindowScenario({ delayOne = 0, delayTwo = 0 } = {}) {
	const fake = fakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "dsh-preset-batch-"));
	const baseURL = await fake.start();
	let ctx;
	let journal;
	try {
		ctx = await boot(baseURL, storageRoot, { plugin: true, auto: false });
		journal = sessionJournal(ctx);
		const parent = await createParent(ctx, "preset-batch-parent");
		const firsts = [fake.hold("BATCH_WORKER_ONE", delayOne), fake.hold("BATCH_WORKER_TWO", delayTwo)];
		const prompts = [
			"BATCH_WORKER_ONE: review the corpus. " + "Background context line that the worker must keep. ".repeat(300),
			"BATCH_WORKER_TWO: review the ledger. " + "Background context line that the worker must keep. ".repeat(300)
		];
		const activations = [];
		for (let index = 0; index < prompts.length; index += 1) {
			const activation = await ctx.subagents.startActivation({
				provider: "spawn", label: `batch worker ${index + 1}`, delivery: "parent",
				request: { parent, prompt: [{ type: "text", text: prompts[index] }] },
				signal: AbortSignal.timeout(30_000)
			});
			activation.result.catch(() => {});
			activations.push(activation);
		}
		const ids = activations.map((activation) => activation.childId);
		await Promise.all(activations.map((_, index) => firsts[index].arrived()));
		assertPreset(ctx, parent, ctx.agents.get(ids[0]));
		assertPreset(ctx, parent, ctx.agents.get(ids[1]));
		const command = ctx.commands.execute(parent, "/subagent-compact all", [], AbortSignal.timeout(35_000));
		await journal.wait(({ sessionId, event }) => sessionId === parent.id && event.type === "command/run", "batch command admission");
		/* Release both held turns; each responds on its configured delay. The
		 * batch is already parked on both idle waits at this point. */
		for (const first of firsts) first.release();
		for (let index = 0; index < ids.length; index += 1) {
			await journal.wait(({ sessionId, event }) => sessionId === ids[index] && event.type === "compaction/summary", `batch summary for child ${index + 1}`);
		}
		const execution = await deadline(command, "batch command result");
		assert.equal(execution.result.kind, "success", JSON.stringify(execution.result));
		assert.match(execution.result.text, /Summary \(completed\) — total 2: compacted 2/);
		assert.match(execution.result.text, new RegExp(`${ids[0]}: compacted[\\s\\S]*${ids[1]}: compacted`), "per-item lines keep the catalog order regardless of completion order");
		for (const id of ids) {
			const summary = journal.entries.find(({ sessionId, event }) => sessionId === id && event.type === "compaction/summary")?.event;
			assert.ok(summary, `child ${id} records the real summary`);
			assert.ok(summary.data.shadowedSeqs.length > 0);
			assert.equal(summary.data.sourceCommandId, execution.commandId, "every summary traces to the one batch command");
			assert.ok(persistedEvents(storageRoot, id).some((event) => event.type === "compaction/summary"), "durability precedes the batch result");
		}
		assert.equal(fake.requests.filter((request) => request.summarizing).length, 2, "one summary request per child");
		for (const activation of activations) {
			const settled = await deadline(activation.result, "compacted child settlement");
			assert.notEqual(settled.stopReason, "error", JSON.stringify(settled));
		}
	} finally {
		journal?.dispose();
		await fake.close();
		await ctx?.fiber.dispose();
		rmSync(storageRoot, { recursive: true, force: true });
	}
}

test("preset: /subagent-compact all compacts every live child through isolated preset engines", { timeout: 45_000 }, () => batchWindowScenario());

test("preset: batch catches the child that settles before its catalog predecessor", { timeout: 45_000 }, () => batchWindowScenario({ delayOne: 600 }));

test("preset: batch catches both children when the second settles later", { timeout: 45_000 }, () => batchWindowScenario({ delayTwo: 600 }));

test("preset: native automatic child compaction works without loading this plugin", { timeout: 30_000 }, async () => {
	const fake = fakeMessagesServer();
	const storageRoot = mkdtempSync(join(tmpdir(), "dsh-preset-native-"));
	const baseURL = await fake.start();
	let ctx;
	let journal;
	try {
		// This composition never imports or mounts ../index.js.
		ctx = await boot(baseURL, storageRoot, { plugin: false, auto: true });
		journal = sessionJournal(ctx);
		const parent = await createParent(ctx, "preset-native-parent");
		assert.equal(ctx.commands.view(parent).get("subagent-compact"), undefined, "this composition does not register the plugin's command");
		const first = fake.hold("FIRST_NATIVE_TURN");
		const activation = await ctx.subagents.startActivation({
			provider: "spawn", label: "native preset worker", delivery: "parent",
			request: { parent, prompt: [{ type: "text", text: "FIRST_NATIVE_TURN: record the corpus findings. " + "Background context line that the worker must keep. ".repeat(300) }] },
			signal: AbortSignal.timeout(25_000)
		});
		activation.result.catch(() => {});
		await first.arrived();
		const childId = activation.childId;
		assertPreset(ctx, parent, ctx.agents.get(childId));
		await ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: "SECOND_NATIVE_TURN: continue." }], { signal: AbortSignal.timeout(10_000) });
		first.release();
		const { event: summary } = await journal.wait(({ sessionId, event }) => sessionId === childId && event.type === "compaction/summary", "native automatic child summary");
		assert.ok(summary.data.shadowedSeqs.length > 0);
		await journal.wait(({ sessionId, event }) => sessionId === childId && event.type === "assistant/message" && JSON.stringify(event.data).includes("Native second turn completed"), "native post-compaction turn");
		const result = await deadline(activation.result, "native activation settlement");
		assert.notEqual(result.stopReason, "error", JSON.stringify(result));
		assert.ok(persistedEvents(storageRoot, childId).some((event) => event.type === "compaction/summary"));
		assert.ok(fake.requests.some((request) => request.summarizing));
		assert.equal(journal.entries.some(({ event }) => event.type === "command/run"), false, "automatic compaction needs no manual command");
	} finally {
		journal?.dispose();
		await fake.close();
		await ctx?.fiber.dispose();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});
