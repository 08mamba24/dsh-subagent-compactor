/**
 * @local/dsh-subagent-compactor — manual history compaction for one of the
 * caller's live direct subagents, reusing the composition's compaction engine.
 *
 * Surfaces:
 * - `/subagent-compact` — no arguments: list the caller session's durable
 *   direct-subagent catalog; with one session id: compact that live child.
 * - `compact_subagent` tool — same operation from inside a model turn.
 *
 * Both surfaces authorize through runtime ownership (`agents.isOwnedBy`),
 * never persisted lineage, and resolve the engine on exactly one of two
 * lawful planes (preset `serviceFor`, or Host `compaction` when the
 * composition has no preset registry); there is no cross-realm fallback.
 *
 * @module @local/dsh-subagent-compactor
 */
import z from "@deepseek-ai/schemastery";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "subagent-compactor";
const inject = ["commands", "tools", "agents", "subagents"];

const Config = z.object({
	waitForIdle: z.boolean().default(true)
});

const USAGE = "Usage: /subagent-compact [<subagent-session-id>]";
/** Closed set of ManualCompactionError codes from @deepseek-ai/dsh-compaction. */
const MANUAL_CODES = new Set(["busy", "cancelled", "changed", "summary", "commit", "persistence"]);
/** Bounded unload wait so one pathological engine cannot hang teardown. */
const DISPOSE_TIMEOUT_MS = 10_000;

/**
 * Map one manual-compaction failure code to a human-readable message.
 * The default branch keeps an unknown runtime code diagnosable instead of
 * throwing: codes are runtime strings, and this plugin is not compiled in the
 * same module tree as the engine, so the closed set cannot be asserted here.
 * @param {string} code - manual compaction error code.
 * @param {string|undefined} diagnostic - engine message for unknown codes.
 * @returns the message shown to the user or model.
 */
function manualFailureText(code, diagnostic) {
	switch (code) {
		case "busy": return "The subagent is not idle, or a compaction is already in progress for its session.";
		case "cancelled": return "Compaction was cancelled.";
		case "changed": return "The history selected for compaction changed before it could be replaced. The attempt is recorded in the subagent's session log.";
		case "summary": return "Compaction could not produce a useful summary. The attempt is recorded in the subagent's session log.";
		case "commit": return "Compaction did not finish cleanly; some session history may have changed. Inspect the subagent's session state before retrying.";
		case "persistence": return "Compaction finished, but the subagent's session could not be saved.";
		default: return `Compaction failed with an unknown error code "${String(code)}"${diagnostic === undefined ? "" : `: ${diagnostic}`}.`;
	}
}

/** Match by name+code: cross-package instanceof is unreliable when the host loads two module generations. */
function isManualCompactionError(error) {
	return error instanceof Error && error.name === "ManualCompactionError" && typeof error.code === "string";
}

/**
 * Resolve the compaction engine for one target agent. Exactly two lawful
 * planes, never a cross-realm fallback:
 * 1. An `agentPresets` registry is present (Web/Desktop): the engine is
 *    published inside the preset's isolated group, and only
 *    `serviceFor(agent, 'compaction')` reaches it. A plain context lookup
 *    (including `agent.ctx`) resolves the Host realm, which is not the
 *    engine instance that owns the agent's session.
 * 2. No registry (headless/ACP-style compositions): when composed at all,
 *    the engine is the Host-plane `compaction` service — the same source the
 *    official `/compact` command injects.
 * @param ctx - plugin context.
 * @param agent - target child agent.
 * @returns `{ ok: true, engine }` or `{ ok: false, reason }`.
 */
function resolveCompactionEngine(ctx, agent) {
	const presets = ctx.get("agentPresets");
	if (presets !== undefined) {
		const engine = presets.serviceFor(agent, "compaction");
		if (engine === undefined) return {
			ok: false,
			reason: "The target's agent preset does not provide a compaction engine; mount @deepseek-ai/dsh-compaction-basic in that preset's compaction group."
		};
		return { ok: true, engine };
	}
	const engine = ctx.get("compaction");
	if (engine === undefined) return {
		ok: false,
		reason: "This composition has no agent preset registry and no Host-plane compaction engine; mount @deepseek-ai/dsh-compaction-basic."
	};
	return { ok: true, engine };
}

/**
 * Await a promise that offers no cancellation parameter, aborting the wait on
 * `signal`. A signal that is already aborted rejects immediately — listening
 * alone would miss it, because `abort` never re-fires. Explicit listener
 * bookkeeping keeps the losing branch from leaving a dangling rejection, so
 * an eternally-busy target cannot hang plugin teardown.
 * @param {Promise<unknown>} promise - the uncancellable wait.
 * @param {AbortSignal|undefined} signal - cancellation scoped to the request.
 * @returns the promise raced against the signal.
 */
function raceAbort(promise, signal) {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		let pending = true;
		const onAbort = () => settle(reject, signal.reason);
		const settle = (settleFn, value) => {
			if (!pending) return;
			pending = false;
			signal.removeEventListener("abort", onAbort);
			settleFn(value);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => settle(resolve, value), (error) => settle(reject, error));
	});
}

/** In-flight operations, each owning a controller the unload path aborts. */
class ActiveOperations {
	entries = new Set();
	begin(operation, controller) {
		const entry = { operation, controller };
		this.entries.add(entry);
		const retire = () => {
			this.entries.delete(entry);
		};
		operation.then(retire, retire);
		return entry;
	}
	abortAll() {
		for (const { controller } of this.entries) controller.abort(new Error("subagent-compactor is unloading"));
	}
	pending() {
		return [...this.entries].map((entry) => entry.operation);
	}
}

/** Caller cancellation stays authoritative; unload adds its own abort source. */
function operationSignal(callerSignal, ownSignal) {
	return callerSignal === undefined ? ownSignal : AbortSignal.any([callerSignal, ownSignal]);
}

/**
 * Compact one of the caller's live direct subagents through the resolved
 * engine. Expected failures return an outcome object; only unexpected
 * non-manual errors propagate.
 * @param ctx - plugin context carrying `agents`.
 * @param config - resolved plugin configuration.
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} targetId - the candidate child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome with `text`, plus compact stats when `outcome === "compacted"`.
 */
async function compactSubagent(ctx, config, caller, targetId, signal, sourceCommandId) {
	if (typeof targetId !== "string" || targetId.trim().length === 0) {
		return { outcome: "usage", text: USAGE };
	}
	const sessionId = targetId.trim();
	const agent = ctx.agents.get(sessionId);
	if (agent === undefined) {
		return { outcome: "not-resident", text: `No live agent with session id "${sessionId}". Only still-live (resident) subagents can be compacted; a child whose settlement already reclaimed it is out of reach.` };
	}
	if (!ctx.agents.isOwnedBy(sessionId, caller)) {
		return { outcome: "not-authorized", text: `Session "${sessionId}" is not one of your live runtime-created direct subagents. Only the exact runtime parent may compact a child.` };
	}
	const resolvedEngine = resolveCompactionEngine(ctx, agent);
	if (!resolvedEngine.ok) return { outcome: "engine-missing", text: resolvedEngine.reason };
	try {
		if (config.waitForIdle) await raceAbort(agent.whenIdle(), signal);
		/* Identity re-check after the wait: a same-id replacement agent is a
		 * different object, and the old session handle must not be compacted. */
		if (ctx.agents.get(sessionId) !== agent) {
			return { outcome: "not-resident", text: `Subagent "${sessionId}" was disposed while waiting for it to become idle.` };
		}
		const result = await resolvedEngine.engine.compactNow(agent, signal, sourceCommandId);
		if (result === null) return { outcome: "nothing-to-compact", text: `No compactable history yet in subagent "${sessionId}".` };
		return {
			outcome: "compacted",
			targetSessionId: sessionId,
			summarySeq: result.summarySeq,
			replacedItems: result.shadowedSeqs.length,
			replacedTokens: result.shadowedTokenCount,
			text: `Compacted subagent "${sessionId}": replaced ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens of the replaced history; the summary sits at session-seq ${result.summarySeq} of the child's own log).`
		};
	} catch (error) {
		/* Signal first: compactNow folds its own caught aborts into `busy`,
		 * so "the caller cancelled" is only decidable from the signal. */
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		if (isManualCompactionError(error)) {
			const known = MANUAL_CODES.has(error.code);
			return {
				outcome: known ? error.code : "unknown-code",
				code: error.code,
				text: manualFailureText(error.code, known ? undefined : error.message)
			};
		}
		throw error;
	}
}

/** Render the durable direct-children catalog of the calling session. */
async function listDirectChildren(ctx, caller, signal) {
	const entries = await ctx.subagents.listChildren(caller.id, signal);
	if (entries.length === 0) return { kind: "success", text: "(no direct subagents on record for this session)" };
	const lines = entries.map((entry) => `${entry.id} [${entry.mode}]${entry.label === undefined ? "" : ` ${entry.label}`}`);
	return { kind: "success", text: ["Direct subagents of this session:", ...lines].join("\n") };
}

/** Expected outcomes the command reports as success rather than error. */
function commandKind(outcome) {
	return outcome === "compacted" || outcome === "nothing-to-compact" ? "success" : "error";
}

function commandHandler(ctx, config, active) {
	return (invocation) => {
		const controller = new AbortController();
		/* One fused signal for every branch, so the plugin's own unload abort
		 * reaches in-flight listings and compactions alike: a bare caller
		 * signal would leave observeSession reads uncancellable. */
		const signal = operationSignal(invocation.signal, controller.signal);
		const operation = (async () => {
			const raw = invocation.rawInput.trim();
			if (raw.length === 0) {
				try {
					return await listDirectChildren(ctx, invocation.agent, signal);
				} catch (error) {
					if (signal.aborted) return { kind: "error", text: "Listing cancelled." };
					return { kind: "error", text: `Listing unavailable: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
			const parts = raw.split(/\s+/);
			if (parts.length > 1) return { kind: "error", text: USAGE };
			const result = await compactSubagent(ctx, config, invocation.agent, parts[0], signal, invocation.commandId);
			/* No sourceEventSeq: it would be written into the *parent* command/done
			 * event, where a bare child-session seq points at the wrong event. The
			 * child session id and its summary seq travel in the text instead. */
			return { kind: commandKind(result.outcome), text: result.text };
		})();
		active.begin(operation, controller);
		return operation;
	};
}

function subagentCompactTool(ctx, config, active) {
	return defineTool({
		name: "compact_subagent",
		description: "Compact the older history of one of your live direct subagents into a summary so the child frees context while staying usable. Use an id from your subagent catalog. Reports how many history items were replaced and where the summary landed in the child's own session log.",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "Session id of your live direct subagent to compact."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true },
					outcome: { type: "string", required: true },
					target_session_id: { type: "string" },
					summary_seq: { type: "number" },
					replaced_items: { type: "number" },
					replaced_tokens: { type: "number" }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		async execute(args, exec) {
			const caller = exec.agent;
			if (caller === undefined) throw new Error("compact_subagent: no calling agent on this execution");
			const controller = new AbortController();
			const operation = compactSubagent(ctx, config, caller, args.session_id, operationSignal(exec.signal, controller.signal), undefined);
			active.begin(operation, controller);
			const result = await operation;
			return {
				text: result.text,
				outcome: result.outcome,
				...result.outcome === "compacted" ? {
					target_session_id: result.targetSessionId,
					summary_seq: result.summarySeq,
					replaced_items: result.replacedItems,
					replaced_tokens: result.replacedTokens
				} : {}
			};
		}
	});
}

/**
 * Register the command and tool inside one effect. The cleanup hook is
 * yielded first so Cordis disposes it last: registrations go offline before
 * in-flight operations are aborted and awaited.
 * @param ctx - plugin context.
 * @param config - row configuration.
 */
function apply(ctx, config = {}) {
	const resolved = Config(config);
	const active = new ActiveOperations();
	ctx.effect(function* () {
		yield async () => {
			active.abortAll();
			const pending = active.pending();
			if (pending.length === 0) return;
			let timer;
			const floor = new Promise((resolve) => {
				timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
			});
			try {
				await Promise.race([Promise.allSettled(pending), floor]);
			} finally {
				clearTimeout(timer);
			}
		};
		yield ctx.commands.register({
			definitionId: CommandDefinitionId("@local/dsh-subagent-compactor"),
			name: "subagent-compact",
			description: "List direct subagents, or compact one live direct subagent's history",
			/* Desktop's command UI only claims a NON-bare invocation (arguments
			 * present) when the definition declares `input`; without it the line
			 * falls through as a plain user message
			 * (dsh-client-ui-commands/lib/client.js claim: `desc.input !== void 0`,
			 * else `if (!bare) return void 0`). Official exemplar: /goal. */
			input: {
				hint: "[<subagent-session-id>]"
			},
			handler: commandHandler(ctx, resolved, active)
		});
		const unregisterTool = ctx.tools.register(subagentCompactTool(ctx, resolved, active));
		yield () => unregisterTool();
	}, "subagent-compactor lifecycle");
}

export { apply, inject, name, Config };
