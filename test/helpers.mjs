/**
 * Shared fixtures for the integration suites: a scriptable Anthropic
 * Messages-compatible fake LLM server, a real Cordis composition of DSH
 * modules from the installed Harness tree, and an instance-independent
 * bounded poll (cold resumes swap Agent objects).
 *
 * @module test/helpers
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

export const PROVIDER = "deepseek-official";
export const MODEL = "deepseek-flash";
export const CHILD_MODEL = "deepseek-chat";

process.env.DEEPSEEK_API_KEY = "test-key-used-by-fake-server";

/**
 * Minimal Anthropic Messages SSE responder scripted by the tests. Each
 * request captures mode/delay at ARRIVAL and records its parsed body, so
 * switching state mid-flight never rewrites a response already being held
 * open. `summarize-fail` streams an error mid-summary.
 */
export function createFakeMessagesServer() {
	const state = { mode: "turn", delayMs: 0, requests: [] };
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const mode = state.mode;
			const delayMs = state.delayMs;
			let body = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				body = {};
			}
			state.requests.push({ url: request.url, mode, delayMs, model: body.model, messages: body.messages });
			const filler = "The worker examined the corpus, recorded structured findings, and kept the log verbose enough to build a compactable history span. ".repeat(40);
			const textByMode = {
				turn: `Turn complete. ${filler}`,
				"turn-short": "Round two done.",
				summarize: "Checkpoint summary: the worker completed its assigned turns; details condensed.",
				"summarize-fail": `Checkpoint summary that deliberately fails the shrink check by being far larger than the replaced span: ${"it restates every detail at verbose length instead of condensing anything, so the engine rejects this summary outright every single time. ".repeat(90)}`,
				turn2: "Follow-up handled after compaction."
			};
			const respond = () => {
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
			if (delayMs > 0) setTimeout(respond, delayMs);
			else respond();
		});
	});
	return {
		state,
		start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}

/**
 * Boot the full Host-plane composition plus the plugin under test. `extra`
 * appends module/config rows after the standard list (e.g. the agent-preset
 * registry for preset-plane journeys); `pluginConfig` configures the plugin.
 */
export async function bootComposition(baseURL, storageRoot, { extra = [], pluginConfig = { waitForIdle: true }, withoutHostCompaction = false } = {}) {
	const moduleNames = [
		"@deepseek-ai/cordis-plugin-timer",
		"@deepseek-ai/dsh-llm",
		"@deepseek-ai/dsh-llm-deepseek-api-key",
		"@deepseek-ai/dsh-system-prompt",
		"@deepseek-ai/dsh-tools",
		"@deepseek-ai/dsh-commands",
		"@deepseek-ai/dsh-fs-local",
		"@deepseek-ai/dsh-session",
		"@deepseek-ai/dsh-session-projection",
		"@deepseek-ai/dsh-session-persistence-jsonl",
		"@deepseek-ai/dsh-session-query",
		"@deepseek-ai/dsh-token-meter",
		...(withoutHostCompaction ? [] : ["@deepseek-ai/dsh-compaction-basic"]),
		"@deepseek-ai/dsh-agent",
		"@deepseek-ai/dsh-agent-loop",
		"@deepseek-ai/dsh-working-directory",
		"@deepseek-ai/dsh-subagent",
		"@deepseek-ai/dsh-subagent-spawn-in-process",
		...extra.map(([moduleName]) => moduleName)
	];
	const modules = {};
	for (const moduleName of moduleNames) modules[moduleName] = await import(moduleName);
	const rows = [
		["@deepseek-ai/cordis-plugin-timer", {}],
		["@deepseek-ai/dsh-llm", {}],
		["@deepseek-ai/dsh-llm-deepseek-api-key", { baseURL, defaultContextWindow: 200000 }],
		["@deepseek-ai/dsh-system-prompt", { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: "You are the integration test worker." }],
		["@deepseek-ai/dsh-tools", {}],
		["@deepseek-ai/dsh-commands", {}],
		["@deepseek-ai/dsh-fs-local", {}],
		["@deepseek-ai/dsh-session", {}],
		["@deepseek-ai/dsh-session-projection", {}],
		["@deepseek-ai/dsh-session-persistence-jsonl", { root: storageRoot, compression: "none" }],
		["@deepseek-ai/dsh-session-query", {}],
		["@deepseek-ai/dsh-token-meter", {}],
		...(withoutHostCompaction ? [] : [["@deepseek-ai/dsh-compaction-basic", { auto: false }]]),
		["@deepseek-ai/dsh-agent", {}],
		["@deepseek-ai/dsh-agent-loop", { agents: [] }],
		["@deepseek-ai/dsh-working-directory", {}],
		["@deepseek-ai/dsh-subagent", {}],
		["@deepseek-ai/dsh-subagent-spawn-in-process", {}],
		...extra
	];
	const ctx = new Context();
	for (const [moduleName, config] of rows) {
		const module = modules[moduleName];
		await ctx.plugin(module.default ?? module, config);
	}
	const plugin = await import("../index.js");
	/* Expose the plugin's own fiber so tests can unload ONLY the compactor
	 * (Host, query, and children stay live) — the unload-loss proofs rely on
	 * exactly that boundary. */
	ctx.compactorFiber = await ctx.plugin(plugin, pluginConfig);
	return ctx;
}

/** Boot with a fresh fake server and temp storage; disposes all of them afterwards. */
export async function withComposition(run, options = {}) {
	const fake = createFakeMessagesServer();
	let ctx;
	let storageRoot;
	try {
		const baseURL = await fake.start();
		storageRoot = mkdtempSync(join(tmpdir(), "subagent-compactor-it-"));
		ctx = await bootComposition(baseURL, storageRoot, options);
		await run(ctx, fake, storageRoot);
	} finally {
		await Promise.resolve(ctx?.fiber?.dispose?.()).catch(() => {});
		await fake.close();
		if (storageRoot !== undefined) rmSync(storageRoot, { recursive: true, force: true });
	}
}

/** Instance-independent bounded poll; cold resumes swap Agent objects. */
export async function waitFor(probe, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("waitFor deadline exceeded");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Snapshot a session's events through the public query lease. */
export async function readEvents(ctx, sessionId) {
	const observation = await ctx.sessionQuery.observeSession(sessionId);
	try {
		return [...observation.events];
	} finally {
		observation[Symbol.dispose]();
	}
}

/** Spawn a real continuable child under `parent` and return its activation. */
export function startChild(ctx, parent, prompt, options = {}) {
	return ctx.subagents.startActivation({
		provider: "spawn",
		label: options.label ?? "integration worker",
		request: {
			prompt: [{ type: "text", text: prompt }],
			parent,
			...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
			...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }
		},
		signal: new AbortController().signal,
		delivery: "parent"
	});
}

/** Run one child to true settlement and wait for the settlement watcher's reclaim. */
export async function settleChild(ctx, parent, prompt, options = {}) {
	const activation = await startChild(ctx, parent, prompt, options);
	const childId = activation.childId;
	await activation.result;
	await waitFor(() => ctx.agents.get(childId) === undefined);
	return childId;
}
