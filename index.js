/**
 * @local/dsh-subagent-compactor — manual history compaction for one of the
 * caller's direct subagents, reusing the composition's compaction engine.
 *
 * Surfaces:
 * - `/subagent-compact` — no arguments: list the caller session's durable
 *   direct-subagent catalog; with one session id: compact that child;
 *   with `--all`: compact every child in one catalog snapshot, serialized,
 *   with honest per-child outcomes and counts.
 * - `compact_subagent` tool — the single-child operation from a model turn.
 * - `compact_all_subagents` tool — the batch operation from a model turn.
 *
 * A target that is still live is authorized through runtime ownership
 * (`agents.isOwnedBy`). A target that already finished is compacted through
 * the host's manager-owned maintenance capability
 * (`ctx.subagents.runMaintenance`, provided by the candidate host patch in
 * host-patch/): the manager restores the child exactly like a continuation,
 * keeps it resident so normal routes deliver, runs the engine's compactNow
 * as the single maintenance job, and hands the activation to the ordinary
 * settlement lifecycle (loop-level admission cutoff, preserve-and-wait for
 * pending input, writer release). This plugin holds no restored handle and
 * never submits a task. On a stock runtime without the capability the cold
 * path refuses explicitly (host-capability-missing). The engine is resolved
 * on exactly one of two lawful planes (preset `serviceFor`, or Host
 * `compaction` when the composition has no preset registry); there is no
 * cross-realm fallback.
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

const USAGE = "Usage: /subagent-compact [--all | <subagent-session-id>]";
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
 * Compact one of the caller's FINISHED continuable children by id through the
 * manager-owned maintenance capability (`ctx.subagents.runMaintenance`):
 * the child is restored exactly like a continuation (persisted-header
 * lineage + own durable descriptor authorization, descriptor route,
 * independent preset or inherited composition, persona, tool filter),
 * becomes resident — so every normal route reaches it through the manager
 * instead of a writer collision — and the engine runs its one maintenance
 * job while the settlement watcher is held back. Afterwards the ordinary
 * settlement takes over: accepted input is processed or preserved, the
 * closing cutoff rejects later input before acceptance, and the writer
 * releases. The plugin holds no handle of its own; nothing here can drop
 * accepted input. No ordinary task is ever submitted.
 * @param ctx - plugin context.
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} sessionId - the candidate child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome object.
 */
async function compactPersistedSubagent(ctx, caller, sessionId, signal, sourceCommandId) {
	if (typeof ctx.subagents.runMaintenance !== "function") {
		return {
			outcome: "host-capability-missing",
			text: `Compaction of finished subagents needs the host's manager-owned maintenance capability (ctx.subagents.runMaintenance), which this DSH runtime does not provide; see docs/HOST_MAINTENANCE_REQUIREMENTS.md. Live-window compaction is unaffected.`
		};
	}
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
			return { liveNow };
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
	if (hasIndependentPresetSelection(ownEvents) && typeof projectionValues?.agentPreset !== "string") {
		return { outcome: "restore-failed", text: `Session "${sessionId}" selected an agent preset, but its current identity is unavailable for restoration; compaction was refused.` };
	}
	/* A read-only pending refusal keeps the common case off the maintenance
	 * path entirely: unprocessed work belongs to a normal continuation, and
	 * the maintenance lifecycle (which would also preserve it) is not needed
	 * just to refuse. */
	const inbox = projectionValues?.inbox;
	if (inbox !== undefined && (inbox["next-turn"]?.length ?? 0) + (inbox["next-step"]?.length ?? 0) > 0) {
		return { outcome: "pending-input", text: `Session "${sessionId}" still holds ${((inbox["next-turn"]?.length ?? 0) + (inbox["next-step"]?.length ?? 0))} persisted pending message(s). Continue it normally (send it another message) so that work is processed first; this refusal leaves the pending work untouched.` };
	}
	/* The manager owns restore, admission, maintenance, and release from here
	 * on. The engine's compactNow is the only maintenance-window job; this
	 * plugin never wraps it in another maintenance call. */
	let engineMissingReason;
	try {
		const result = await ctx.subagents.runMaintenance(caller, sessionId, {
			signal,
			job: async (agent, jobSignal) => {
				const resolvedEngine = resolveCompactionEngine(ctx, agent);
				if (!resolvedEngine.ok) {
					engineMissingReason = resolvedEngine.reason;
					return null;
				}
				return resolvedEngine.engine.compactNow(agent, jobSignal, sourceCommandId);
			}
		});
		if (engineMissingReason !== undefined) return { outcome: "engine-missing", text: engineMissingReason };
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
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		if (isManualCompactionError(error)) {
			const known = MANUAL_CODES.has(error.code);
			return {
				outcome: known ? error.code : "unknown-code",
				code: error.code,
				text: manualFailureText(error.code, known ? undefined : error.message)
			};
		}
		if (error instanceof Error && error.name === "SubagentError") {
			if (error.code === "UNAUTHORIZED") {
				return { outcome: "not-authorized", text: `Session "${sessionId}" belongs to another parent session; only its direct runtime parent may compact it.` };
			}
			if (error.code === "DUPLICATE_CHILD" || error.code === "ACTIVATION_CLOSING" || error.code === "DRAINING") {
				return { outcome: "busy-target", text: `Subagent "${sessionId}" has live activity in flight (a continuation or another maintenance); retry shortly.` };
			}
			if (error.code === "PERSISTENCE_UNAVAILABLE" || error.code === "CONTINUATION_UNAVAILABLE") {
				return { outcome: "query-unavailable", text: error.message };
			}
			return { outcome: "restore-failed", text: `Session "${sessionId}" could not be restored for compaction: ${error.message}` };
		}
		if (chainHasName(error, "SessionAlreadyOwnedError")) {
			return { outcome: "busy-target", text: `Session "${sessionId}" is concurrently owned by another live writer; retry shortly.` };
		}
		throw error;
	}
}

async function compactSubagent(ctx, locks, config, caller, targetId, signal, sourceCommandId) {
	if (typeof targetId !== "string" || targetId.trim().length === 0) {
		return { outcome: "usage", text: USAGE };
	}
	const sessionId = targetId.trim();
	if (!locks.tryAcquire(sessionId)) {
		return { outcome: "busy-target", text: `A compaction for subagent "${sessionId}" is already in progress.` };
	}
	try {
		let agent = ctx.agents.get(sessionId);
		if (agent === undefined) {
			const cold = await compactPersistedSubagent(ctx, caller, sessionId, signal, sourceCommandId);
			if (cold.liveNow === undefined) return cold;
			/* The target raced back live during cold resolution: the ordinary
			 * live path applies, with its own authorization. */
			agent = cold.liveNow;
		}
		if (!ctx.agents.isOwnedBy(sessionId, caller)) {
			return { outcome: "not-authorized", text: `Session "${sessionId}" is not one of your live runtime-created direct subagents. Only the exact runtime parent may compact a child.` };
		}
		return await compactLiveAgent(ctx, config, caller, agent, sessionId, signal, sourceCommandId);
	} finally {
		locks.release(sessionId);
	}
}

/**
 * Compact every direct subagent in ONE durable catalog snapshot of the
 * calling parent: the snapshot is taken once at start (children spawned
 * afterwards belong to the next run), ids are de-duplicated, and each item
 * runs through the ordinary per-target compaction (live wait or cold
 * maintenance) SERIALLY under the same per-target locks — a concurrent
 * single compaction of the same target reports busy. Every item reports its
 * own outcome and reason; one item's failure never hides the rest. A batch
 * signal abort stops UNSTARTED items (reported as not-started) and preserves
 * every finished result; a cancelled batch never reports success. Each
 * compaction still costs one summary request on the child's own route.
 */
async function compactAllSubagents(ctx, locks, config, caller, signal, sourceCommandId) {
	let entries;
	try {
		entries = await ctx.subagents.listChildren(caller.id, signal);
	} catch (error) {
		if (signal.aborted) return { outcome: "batch-cancelled", text: "Batch compaction cancelled before the catalog was read.", counts: emptyBatchCounts() };
		return { outcome: "listing-failed", text: `Batch catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, counts: emptyBatchCounts() };
	}
	const seen = new Set();
	const items = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		items.push(entry);
	}
	if (items.length === 0) {
		return { outcome: "empty-catalog", text: "(no direct subagents on record for this session; nothing to compact)", counts: emptyBatchCounts() };
	}
	const counts = { compacted: 0, "nothing-to-compact": 0, failed: 0, cancelled: 0, "not-started": 0 };
	const lines = [];
	for (const item of items) {
		if (signal.aborted) {
			counts["not-started"] += 1;
			lines.push(`${item.id}: not-started (batch cancelled before this child began)`);
			continue;
		}
		let result;
		try {
			result = await compactSubagent(ctx, locks, config, caller, item.id, signal, sourceCommandId);
		} catch (error) {
			result = { outcome: "error", text: `unexpected error: ${error instanceof Error ? error.message : String(error)}` };
		}
		switch (result.outcome) {
			case "compacted":
			case "release-failed":
				counts.compacted += 1;
				break;
			case "nothing-to-compact":
				counts["nothing-to-compact"] += 1;
				break;
			case "cancelled":
				counts.cancelled += 1;
				break;
			default:
				counts.failed += 1;
				break;
		}
		if (result.outcome === "compacted" || result.outcome === "release-failed") {
			lines.push(`${item.id}: ${result.outcome} — replaced ${result.replacedItems} items (~${result.replacedTokens} tokens; summary at session-seq ${result.summarySeq})`);
		} else if (result.outcome === "usage") {
			lines.push(`${item.id}: skipped (usage)`);
		} else {
			lines.push(`${item.id}: ${result.outcome} — ${result.text}`);
		}
	}
	const summary = `Summary — total ${items.length}: compacted ${counts.compacted}, nothing-to-compact ${counts["nothing-to-compact"]}, failed ${counts.failed}, cancelled ${counts.cancelled}, not-started: ${counts["not-started"]}.`;
	const text = ["Batch compaction of the caller's direct-subagent snapshot:", ...lines, summary].join("\n");
	return { outcome: signal.aborted ? "batch-cancelled" : "completed", text, counts };
}

function emptyBatchCounts() {
	return { compacted: 0, "nothing-to-compact": 0, failed: 0, cancelled: 0, "not-started": 0 };
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

/** Batch outcomes the command reports as success rather than error. */
function batchCommandKind(outcome) {
	return outcome === "completed" || outcome === "empty-catalog" ? "success" : "error";
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
			if (parts[0] === "--all") {
				if (parts.length > 1) return { kind: "error", text: `${USAGE} (--all takes no other arguments)` };
				const batch = await compactAllSubagents(ctx, locks, config, invocation.agent, signal, invocation.commandId);
				return { kind: batchCommandKind(batch.outcome), text: batch.text };
			}
			if (parts.length > 1) return { kind: "error", text: USAGE };
			const result = await compactSubagent(ctx, locks, config, invocation.agent, parts[0], signal, invocation.commandId);
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
			const operation = compactSubagent(ctx, locks, config, caller, args.session_id, operationSignal(exec.signal, controller.signal), undefined);
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

function compactAllSubagentsTool(ctx, locks, config, active) {
	return defineTool({
		name: "compact_all_subagents",
		description: "Compact the older history of ALL of your direct subagents in one run — every child in the current catalog snapshot (live children, and continuable children that already finished), serialized one at a time. Reports per-child outcomes and full counts. Each compacted child costs one summary request on its own model route. Cancellation stops children that have not started yet; finished results are kept.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true },
					outcome: { type: "string", required: true },
					total: { type: "number" },
					compacted: { type: "number" },
					nothing_to_compact: { type: "number" },
					failed: { type: "number" },
					cancelled: { type: "number" },
					not_started: { type: "number" }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		async execute(_args, exec) {
			const caller = exec.agent;
			if (caller === undefined) throw new Error("compact_all_subagents: no calling agent on this execution");
			const controller = new AbortController();
			const operation = compactAllSubagents(ctx, locks, config, caller, operationSignal(exec.signal, controller.signal), undefined);
			active.begin(operation, controller);
			const result = await operation;
			const counts = result.counts ?? emptyBatchCounts();
			return {
				text: result.text,
				outcome: result.outcome,
				...counts["not-started"] + counts.compacted + counts["nothing-to-compact"] + counts.failed + counts.cancelled > 0 || result.outcome !== "empty-catalog" ? {
					total: totalCount(result.text),
					compacted: counts.compacted,
					nothing_to_compact: counts["nothing-to-compact"],
					failed: counts.failed,
					cancelled: counts.cancelled,
					not_started: counts["not-started"]
				} : { total: 0 }
			};
		}
	});
}

/** Parse the batch total back out of the summary line for the tool output. */
function totalCount(text) {
	const match = /total (\d+):/.exec(text ?? "");
	return match === null ? 0 : Number(match[1]);
}

/**
 * Register the command and tools inside one effect. The cleanup hook is
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
			description: "List direct subagents, compact one by id, or compact all of them (--all)",
			/* Desktop's command UI only claims a NON-bare invocation (arguments
			 * present) when the definition declares `input`; without it the line
			 * falls through as a plain user message
			 * (dsh-client-ui-commands/lib/client.js claim: `desc.input !== void 0`,
			 * else `if (!bare) return void 0`). Official exemplar: /goal. */
			input: {
				hint: "[--all | <subagent-session-id>]"
			},
			handler: commandHandler(ctx, locks, resolved, active)
		});
		const unregisterTool = ctx.tools.register(subagentCompactTool(ctx, locks, resolved, active));
		const unregisterBatchTool = ctx.tools.register(compactAllSubagentsTool(ctx, locks, resolved, active));
		yield () => {
			unregisterBatchTool();
			unregisterTool();
		};
	}, "subagent-compactor lifecycle");
}

export { apply, inject, name, Config };
