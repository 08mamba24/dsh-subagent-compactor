/**
 * @local/dsh-subagent-compactor — manual history compaction for one of the
 * caller's direct subagents, reusing the composition's compaction engine.
 *
 * Surfaces:
 * - `/subagent-compact` — no arguments: list the caller session's durable
 *   direct-subagent catalog; with one session id: compact that child.
 * - `compact_subagent` tool — same operation from inside a model turn.
 *
 * A target that is still live is authorized through runtime ownership
 * (`agents.isOwnedBy`). A target that already finished is restored from
 * persistence through the public `agents.resume` + the child's own durable
 * `subagent/descriptor` (the same reconstruction the subagent manager uses
 * for continuation), compacted in a maintenance window, and released — no
 * new task is submitted and no live window is raced. Release is a cutoff:
 * input accepted through the published Agent's public surface during the
 * window is fully processed before the handle goes away, and pending input
 * found in the loaded snapshot strands the handle instead of being
 * cancelled. The engine is resolved on exactly one of two lawful planes
 * (preset `serviceFor`, or Host `compaction` when the composition has no
 * preset registry); there is no cross-realm fallback.
 *
 * @module @local/dsh-subagent-compactor
 */
import z from "@deepseek-ai/schemastery";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { applyChildComposition, foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";

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

/** Walk an error chain for a peer-package class name (cross-package instanceof is unreliable). */
function chainHasName(error, errorName) {
	for (let cause = error; cause instanceof Error; cause = cause.cause) {
		if (cause.name === errorName) return true;
	}
	return false;
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

/**
 * Per-target serialization of compaction requests: one operation per session
 * id at a time. This serializes the plugin's own operations only; it does not
 * fence the host's message admission (competing deliveries fail cleanly at
 * the persistence writer the cold path holds, before acceptance).
 */
class TargetLocks {
	held = new Map();
	tryAcquire(sessionId) {
		if (this.held.has(sessionId)) return false;
		this.held.set(sessionId, true);
		return true;
	}
	release(sessionId) {
		this.held.delete(sessionId);
	}
}

/** Caller cancellation stays authoritative; unload adds its own abort source. */
function operationSignal(callerSignal, ownSignal) {
	return callerSignal === undefined ? ownSignal : AbortSignal.any([callerSignal, ownSignal]);
}

/**
 * Run the engine compaction against one agent the caller already owns,
 * mapping the six-code ManualCompactionError contract and signal-first
 * cancellation to outcome objects. Unexpected non-manual errors propagate.
 * @param ctx - plugin context.
 * @param agent - owned target child agent.
 * @param {string} sessionId - target session id for messages.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome with `text`, plus compact stats when `outcome === "compacted"`.
 */
async function runEngineCompaction(ctx, agent, sessionId, signal, sourceCommandId) {
	const resolvedEngine = resolveCompactionEngine(ctx, agent);
	if (!resolvedEngine.ok) return { outcome: "engine-missing", text: resolvedEngine.reason };
	try {
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

/**
 * Compact one of the caller's LIVE direct subagents: wait for idle (when
 * configured), re-check the registry identity after the wait, and run the
 * engine. The identity re-check matters: a same-id replacement agent is a
 * different object, and the old session handle must not be compacted.
 * @param ctx - plugin context carrying `agents`.
 * @param config - resolved plugin configuration.
 * @param caller - the exact live Agent authorizing the operation.
 * @param agent - the live target agent.
 * @param {string} sessionId - target session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome object.
 */
async function compactLiveAgent(ctx, config, caller, agent, sessionId, signal, sourceCommandId) {
	void caller;
	try {
		if (config.waitForIdle) await raceAbort(agent.whenIdle(), signal);
		/* Identity re-check after the wait: a same-id replacement agent is a
		 * different object, and the old session handle must not be compacted. */
		if (ctx.agents.get(sessionId) !== agent) {
			return { outcome: "not-resident", text: `Subagent "${sessionId}" was disposed while waiting for it to become idle.` };
		}
		return await runEngineCompaction(ctx, agent, sessionId, signal, sourceCommandId);
	} catch (error) {
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		throw error;
	}
}

/** Creation-time preset selection precedes the child's own descriptor; mirrors the manager's rule. */
function hasIndependentPresetSelection(ownEvents) {
	for (const event of ownEvents) {
		if (event.type === "subagent/descriptor") return false;
		if (event.type === "agent-preset/selected") return true;
	}
	return false;
}

/**
 * Compact one of the caller's FINISHED continuable children by id: observe
 * the persisted session, authorize the direct-parent lineage from the
 * authoritative child header and durable descriptor, refuse when durable
 * pending input exists, then restore the child through the public
 * `agents.resume` with the composition the manager would restore
 * (`applyChildComposition`: independent preset or inherited, persona, tool
 * filter; the descriptor's own route with its optional semantics), compact
 * in the maintenance window, and release the writer this operation created.
 * No ordinary task is ever submitted.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration (used only when the target
 *   races back live during resolution).
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} sessionId - the candidate child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome object.
 */
async function compactPersistedSubagent(ctx, active, config, caller, sessionId, signal, unloadSignal, sourceCommandId) {
	const query = ctx.get("sessionQuery");
	if (query === undefined) {
		return { outcome: "query-unavailable", text: `Subagent "${sessionId}" is not live, and this composition has no sessionQuery service to load persisted sessions; compaction was refused.` };
	}
	let observation;
	try {
		observation = await query.observeSession(sessionId, { signal });
	} catch (error) {
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		if (chainHasName(error, "SessionQueryError") && /not found/i.test(error.message)) {
			return { outcome: "unknown-session", text: `No live agent or persisted session with id "${sessionId}".` };
		}
		return { outcome: "query-unavailable", text: `Session "${sessionId}" could not be observed: ${error instanceof Error ? error.message : String(error)}` };
	}
	let header;
	let ownEvents;
	let projectionValues;
	try {
		if (ctx.agents.get(caller.id) !== caller) {
			return { outcome: "not-authorized", text: `The calling agent is no longer live; compaction of "${sessionId}" was refused.` };
		}
		/* The target raced back live (e.g. a concurrent continuation resumed
		 * it): the ordinary live path applies, with its own authorization. */
		const liveNow = ctx.agents.get(sessionId);
		if (liveNow !== undefined) {
			if (!ctx.agents.isOwnedBy(sessionId, caller)) {
				return { outcome: "not-authorized", text: `Session "${sessionId}" is not one of your live runtime-created direct subagents. Only the exact runtime parent may compact a child.` };
			}
			return await compactLiveAgent(ctx, config, caller, liveNow, sessionId, signal, sourceCommandId);
		}
		header = observation.header;
		ownEvents = [...observation.events.slice(observation.inheritedEventCount)];
		projectionValues = observation.projections?.values;
	} finally {
		observation[Symbol.dispose]();
	}
	if (header.parentSession !== caller.id) {
		return { outcome: "not-authorized", text: `Session "${sessionId}" belongs to another parent session; only its direct runtime parent may compact it.` };
	}
	let descriptor;
	try {
		descriptor = foldSubagentDescriptor(ownEvents);
	} catch (error) {
		return { outcome: "unsupported-target", text: `Session "${sessionId}" has a malformed persisted subagent descriptor: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (descriptor === undefined) {
		return { outcome: "unsupported-target", text: `Session "${sessionId}" has no supported subagent descriptor; it cannot be restored for in-place compaction.` };
	}
	if (descriptor.mode !== "continuable") {
		return { outcome: "unsupported-target", text: `Session "${sessionId}" records subagent mode "${descriptor.mode}"; only continuable children can be compacted in place.` };
	}
	/* Independent preset selections must restore their exact preset; the
	 * current identity comes from the session's agentPreset projection. */
	const composition = { agentPreset: undefined, persona: descriptor.persona, toolFilter: descriptor.toolFilter };
	if (hasIndependentPresetSelection(ownEvents)) {
		const selected = projectionValues?.agentPreset;
		if (typeof selected !== "string") {
			return { outcome: "restore-failed", text: `Session "${sessionId}" selected an agent preset, but its current identity is unavailable for restoration; compaction was refused.` };
		}
		composition.agentPreset = selected;
	}
	/* Durable pending input must be checked BEFORE materializing anything:
	 * releasing a restored handle durably cancels parked inbox input, so a
	 * busy refusal here is what preserves that work for a normal continuation. */
	const inbox = projectionValues?.inbox;
	if (inbox === undefined) {
		return { outcome: "restore-failed", text: `Pending input for "${sessionId}" cannot be verified in this composition (no inbox projection); compaction was refused.` };
	}
	const pendingCount = (inbox["next-turn"]?.length ?? 0) + (inbox["next-step"]?.length ?? 0);
	if (pendingCount > 0) {
		return { outcome: "pending-input", text: `Session "${sessionId}" still holds ${pendingCount} persisted pending message(s). Continue it normally (send it another message) so that work is processed first; this refusal leaves the pending work untouched.` };
	}
	const agentOptions = {
		...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
		...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
		...descriptor.agentReasoningEffort !== undefined ? { reasoningEffort: descriptor.agentReasoningEffort } : {}
	};
	let restored;
	try {
		restored = await ctx.agents.resume({
			resumeSessionId: sessionId,
			parentAgent: caller,
			agentOptions,
			signal,
			setup: async (childCtx) => {
				/* The setup wrapper returns void: applyChildComposition's preset
				 * mount receipt must not become a setup commit object. */
				await applyChildComposition(childCtx, caller, composition);
			}
		});
	} catch (error) {
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		if (chainHasName(error, "SessionAlreadyOwnedError")) {
			return { outcome: "busy-target", text: `Session "${sessionId}" is concurrently owned by another live writer (a resume or continuation is in flight); retry shortly.` };
		}
		return { outcome: "restore-failed", text: `Session "${sessionId}" could not be restored for compaction: ${error instanceof Error ? error.message : String(error)}` };
	}
	/* The loaded snapshot is authoritative: pending input that the read
	 * pre-check could not see (another legal writer raced between the
	 * observation and this writer) must not be compacted over AND must not
	 * be released through the queue-clearing dispose path. Strand the
	 * restored handle on a background drain instead: the pending work stays
	 * durable and untouched, and the handle releases only after that input
	 * has actually been processed (a later public input — followup/steer —
	 * wakes the loop and consumes it). Unload terminates the strand through
	 * the same dispose every live agent takes on teardown. */
	if (restored.agent.inbox?.hasPending === true) {
		const strandedController = new AbortController();
		active.begin(drainRestoredAgent(restored.agent, restored, strandedController.signal), strandedController);
		return {
			outcome: "pending-input",
			text: `Session "${sessionId}" holds ${restored.agent.inbox.nextTurn.length + restored.agent.inbox.nextStep.length} pending message(s) in the loaded snapshot (input raced in while this operation was starting). Compaction was refused; the pending work is untouched and this restored session stays resident until that input is processed, so a continuation of the same id will be temporarily refused. Send the child another message (any public input completes the parked work), or retry after it drains. Public DSH APIs currently offer no way to release a restored handle while preserving accepted input; this residency is the documented workaround.`
		};
	}
	let outcome;
	try {
		outcome = await runEngineCompaction(ctx, restored.agent, sessionId, signal, sourceCommandId);
	} catch (error) {
		if (signal !== undefined && signal.aborted) {
			outcome = { outcome: "cancelled", text: "Compaction cancelled." };
		} else {
			/* Release cutoff still applies on the throw path: input accepted
			 * during the window must drain before the handle goes away. */
			await drainRestoredAgent(restored.agent, restored, unloadSignal).catch(() => undefined);
			throw error;
		}
	}
	/* Release cutoff: wait until every input accepted during the maintenance
	 * window has been fully processed (the maintenance latch wakes a turn
	 * that consumes it), then release the writer. Input that never wakes the
	 * loop (no-wake injections) cannot be driven by this plugin without fake
	 * messages, so the drain waits for the next public input to advance it;
	 * unload terminates through the ordinary dispose. */
	try {
		await drainRestoredAgent(restored.agent, restored, unloadSignal);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (outcome.outcome === "compacted") {
			outcome = {
				outcome: "release-failed",
				targetSessionId: outcome.targetSessionId,
				summarySeq: outcome.summarySeq,
				replacedItems: outcome.replacedItems,
				replacedTokens: outcome.replacedTokens,
				text: `${outcome.text} (warning: the restored maintenance agent could not be released cleanly: ${detail}; its writer releases when that handle drains.)`
			};
		} else {
			outcome = { ...outcome, text: `${outcome.text} (warning: releasing the restored agent also failed: ${detail}.)` };
		}
	}
	return outcome;
}

/** Resolve when the agent's inbox next changes activity, or `signal` aborts. */
function awaitInboxActivity(agent, signal) {
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			for (const dispose of disposers) dispose();
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const disposers = [
			agent.ctx.on("agent/inbox/inserted", done),
			agent.ctx.on("agent/inbox/claimed", done),
			agent.ctx.on("agent/inbox/discarded", done)
		];
		const onAbort = () => done();
		signal?.addEventListener("abort", onAbort, { once: true });
		/* Re-check after subscribing: the deciding event may have fired
		 * between the caller's check and these registrations. */
		if (signal?.aborted || agent.inbox.hasPending !== true || agent.status === "running") done();
	});
}

/**
 * Release cutoff for one restored maintenance handle: resolve only after the
 * agent is idle AND its inbox holds no accepted-but-unprocessed input, then
 * dispose the handle (an empty inbox makes the teardown's cancel a no-op, so
 * nothing accepted is ever cancelled). No-wake pending input cannot be driven
 * without fake messages, so the drain parks until the next public input
 * advances the loop; `signal` (plugin unload) terminates through the ordinary
 * dispose — the same teardown every live agent takes, queue included.
 * @param agent - the restored Agent (public whenIdle/inbox/ctx surface).
 * @param handle - the owning AgentHandle whose dispose releases the writer.
 * @param signal - unload-scoped termination signal.
 */
async function drainRestoredAgent(agent, handle, signal) {
	for (;;) {
		await agent.whenIdle();
		if (agent.inbox.hasPending !== true) break;
		if (signal?.aborted) break;
		await awaitInboxActivity(agent, signal);
	}
	await handle.dispose();
}

/**
 * Compact one of the caller's direct subagents — live, or persisted after it
 * finished — through the resolved engine. Expected failures return an
 * outcome object; only unexpected non-manual errors propagate.
 * @param ctx - plugin context carrying `agents`.
 * @param locks - the plugin's per-target operation locks.
 * @param config - resolved plugin configuration.
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} targetId - the candidate child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome with `text`, plus compact stats when `outcome === "compacted"`.
 */
async function compactSubagent(ctx, locks, active, config, caller, targetId, signal, unloadSignal, sourceCommandId) {
	if (typeof targetId !== "string" || targetId.trim().length === 0) {
		return { outcome: "usage", text: USAGE };
	}
	const sessionId = targetId.trim();
	if (!locks.tryAcquire(sessionId)) {
		return { outcome: "busy-target", text: `A compaction for subagent "${sessionId}" is already in progress.` };
	}
	try {
		const agent = ctx.agents.get(sessionId);
		if (agent !== undefined) {
			if (!ctx.agents.isOwnedBy(sessionId, caller)) {
				return { outcome: "not-authorized", text: `Session "${sessionId}" is not one of your live runtime-created direct subagents. Only the exact runtime parent may compact a child.` };
			}
			return await compactLiveAgent(ctx, config, caller, agent, sessionId, signal, sourceCommandId);
		}
		return await compactPersistedSubagent(ctx, active, config, caller, sessionId, signal, unloadSignal, sourceCommandId);
	} finally {
		locks.release(sessionId);
	}
}

/** Render the durable direct-children catalog of the calling session. */
async function listDirectChildren(ctx, caller, signal) {
	const entries = await ctx.subagents.listChildren(caller.id, signal);
	if (entries.length === 0) return { kind: "success", text: "(no direct subagents on record for this session)" };
	const lines = entries.map((entry) => {
		const live = ctx.agents.get(entry.id) !== undefined;
		return `${entry.id} [${entry.mode}]${entry.label === undefined ? "" : ` ${entry.label}`} — ${live ? "live" : "persisted (not loaded)"}`;
	});
	return { kind: "success", text: ["Direct subagents of this session (observed at listing time; a listing is not a reservation):", ...lines].join("\n") };
}

/** Expected outcomes the command reports as success rather than error. */
function commandKind(outcome) {
	return outcome === "compacted" || outcome === "nothing-to-compact" ? "success" : "error";
}

function commandHandler(ctx, locks, config, active) {
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
			const result = await compactSubagent(ctx, locks, active, config, invocation.agent, parts[0], signal, controller.signal, invocation.commandId);
			/* No sourceEventSeq: it would be written into the *parent* command/done
			 * event, where a bare child-session seq points at the wrong event. The
			 * child session id and its summary seq travel in the text instead. */
			return { kind: commandKind(result.outcome), text: result.text };
		})();
		active.begin(operation, controller);
		return operation;
	};
}

function subagentCompactTool(ctx, locks, config, active) {
	return defineTool({
		name: "compact_subagent",
		description: "Compact the older history of one of your direct subagents into a summary so the child frees context while staying usable — the child may be live, or a continuable child that already finished (compacted in place by its session id, no new task needed). Use an id from your subagent catalog. Reports how many history items were replaced and where the summary landed in the child's own session log.",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "Session id of your direct subagent to compact (live or persisted continuable)."
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
			const operation = compactSubagent(ctx, locks, active, config, caller, args.session_id, operationSignal(exec.signal, controller.signal), controller.signal, undefined);
			active.begin(operation, controller);
			const result = await operation;
			return {
				text: result.text,
				outcome: result.outcome,
				...result.outcome === "compacted" || result.outcome === "release-failed" ? {
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
	const locks = new TargetLocks();
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
			description: "List direct subagents, or compact one direct subagent's history (live or finished continuable)",
			/* Desktop's command UI only claims a NON-bare invocation (arguments
			 * present) when the definition declares `input`; without it the line
			 * falls through as a plain user message
			 * (dsh-client-ui-commands/lib/client.js claim: `desc.input !== void 0`,
			 * else `if (!bare) return void 0`). Official exemplar: /goal. */
			input: {
				hint: "[<subagent-session-id>]"
			},
			handler: commandHandler(ctx, locks, resolved, active)
		});
		const unregisterTool = ctx.tools.register(subagentCompactTool(ctx, locks, resolved, active));
		yield () => unregisterTool();
	}, "subagent-compactor lifecycle");
}

export { apply, inject, name, Config };
