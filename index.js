/**
 * @local/dsh-subagent-compactor — manual history compaction for the caller's
 * direct subagents, reusing the composition's compaction engine.
 *
 * Surfaces:
 * - `/subagent-compact` — no arguments: list the caller session's durable
 *   direct-subagent catalog; with `all` (or `--all`): compact every direct
 *   subagent in one catalog snapshot — live children directly, settled
 *   continuable children by resuming them first; with one session id: the
 *   same single-child operation for that id.
 * - `compact_subagent` tool — the single-child operation from inside a model turn.
 *
 * A settled child is compacted through the normal continuation lifecycle: a
 * scoped `subagent/start` listener is registered first, then the ordinary
 * `subagents.sendMessage` resumes the same id under its own preset, routing,
 * and ownership. The start edge fires synchronously after the manager has
 * finished resume and ownership but before the message is delivered, and the
 * listener calls `engine.compactNow` right there — synchronously reserving
 * the maintenance window — never awaiting `whenIdle` first (the resume agent
 * is already idle at that edge) and never wrapping the engine in another
 * maintenance call. The wake message itself stays parked in the inbox and is
 * answered only after the summary commits, so compaction is a real extra
 * exchange, not an offline transaction: if the summary fails the delivered
 * message still runs. Non-continuable, external, or unrestorable targets are
 * refused with their host reason, never silently dropped.
 *
 * The batch runs all items CONCURRENTLY (each live item parks on its own
 * idle wait immediately, because the live window closes at settlement; each
 * settled item waits for host admission when capacity is full) under the same
 * per-target locks as the single-child path; one item's failure never hides the rest. A run in
 * which nothing was compacted reports `nothing-compacted` explicitly instead
 * of implying success.
 *
 * Both surfaces authorize through runtime ownership (`agents.isOwnedBy`) and
 * the manager's own continuation admission — never persisted lineage alone —
 * and resolve the engine on exactly one of two lawful planes (preset
 * `serviceFor`, or Host `compaction` when the composition has no preset
 * registry); there is no cross-realm fallback.
 *
 * @module @local/dsh-subagent-compactor
 */
import z from "@deepseek-ai/schemastery";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "subagent-compactor";
const inject = ["commands", "tools", "agents", "subagents"];

const Config = z.object({
	waitForIdle: z.boolean().default(true),
	/* Settled continuable children are resumed (one real wake message each)
	 * so they can be compacted. Turn off to restrict every surface to
	 * children that are live right now. */
	resumeInactive: z.boolean().default(true),
	/* A nested caller may itself keep the shared pool full. Waiting for
	 * capacity must therefore be bounded even without caller cancellation. */
	resumeCapacityTimeoutMs: z.number().step(1).min(1).max(600_000).default(120_000)
});

const USAGE = "Usage: /subagent-compact [all | <subagent-session-id>]";
/** Closed set of ManualCompactionError codes from @deepseek-ai/dsh-compaction. */
const MANUAL_CODES = new Set(["busy", "cancelled", "changed", "summary", "commit", "persistence"]);
/** Bounded unload wait so one pathological engine cannot hang teardown. */
const DISPOSE_TIMEOUT_MS = 10_000;
/** Public end events miss unpublished rollback and dynamic capacity changes. */
const CAPACITY_PROBE_MS = 1_000;
/**
 * The one message this plugin ever sends a settled child. It asks only for a
 * maintenance acknowledgment after the summary commits — it must never read
 * as instructions for new work, because the child will answer it with a real
 * model turn after compaction.
 */
const WAKE_MESSAGE = [{ type: "text", text: "[history-compaction maintenance] A history compaction is being applied to this session. When it completes, acknowledge this message with a single short line and stop; do not start new work." }];

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
 * Per-target reentry locks so a batch item and a concurrent single invocation
 * targeting the same child cannot both reach the engine: the second caller
 * gets an explicit `busy-target` instead of relying on the engine's own busy
 * classification. Locks are advisory within this plugin instance only.
 */
class TargetLocks {
	held = new Set();
	tryAcquire(sessionId) {
		if (this.held.has(sessionId)) return false;
		this.held.add(sessionId);
		return true;
	}
	release(sessionId) {
		this.held.delete(sessionId);
	}
}

/**
 * Compact one of the caller's live direct subagents through the resolved
 * engine, under the per-target reentry lock. Expected failures return an
 * outcome object; only unexpected non-manual errors propagate.
 * @param ctx - plugin context carrying `agents`.
 * @param locks - the plugin's per-target reentry locks.
 * @param config - resolved plugin configuration.
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} targetId - the candidate child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome with `text`, plus compact stats when `outcome === "compacted"`.
 */
async function compactSubagent(ctx, locks, config, caller, targetId, signal, sourceCommandId) {
	if (typeof targetId !== "string" || targetId.trim().length === 0) {
		return { outcome: "usage", text: USAGE };
	}
	const sessionId = targetId.trim();
	if (!locks.tryAcquire(sessionId)) {
		return { outcome: "busy-target", text: `A compaction for subagent "${sessionId}" is already in progress.` };
	}
	try {
		if (ctx.agents.get(sessionId) !== undefined) {
			const result = await compactLiveSubagent(ctx, config, caller, sessionId, signal, sourceCommandId);
			/* A true mid-wait reclamation (no live agent at all) still gets
			 * one admitted resume; a same-id instance swap stays a refusal —
			 * the stale handle must not be compacted and the replacement is
			 * a fresh target the caller may address explicitly. */
			if (result.outcome !== "not-resident" || !config.resumeInactive || ctx.agents.get(sessionId) !== undefined) return result;
		}
		if (config.resumeInactive) {
			return await resumeAndCompactSubagent(ctx, config, caller, sessionId, signal, sourceCommandId);
		}
		return { outcome: "not-resident", text: `No live agent with session id "${sessionId}". Only still-live (resident) subagents can be compacted here (resumeInactive is disabled); a child whose settlement already reclaimed it is out of reach.` };
	} finally {
		locks.release(sessionId);
	}
}

/**
 * The single-target live compaction, called with the target's per-session
 * lock already held. Expected failures return an outcome object; only
 * unexpected non-manual errors propagate.
 */
async function compactLiveSubagent(ctx, config, caller, sessionId, signal, sourceCommandId) {
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
		return compactedOutcome(sessionId, result, "Compacted ");
	} catch (error) {
		const classified = classifyEngineError(error, signal);
		if (classified !== undefined) return classified;
		throw error;
	}
}

/** Render one committed compactNow result; `lead` distinguishes the resume path. */
function compactedOutcome(sessionId, result, lead) {
	return {
		outcome: "compacted",
		targetSessionId: sessionId,
		summarySeq: result.summarySeq,
		replacedItems: result.shadowedSeqs.length,
		replacedTokens: result.shadowedTokenCount,
		text: `${lead}subagent "${sessionId}": replaced ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens of the replaced history; the summary sits at session-seq ${result.summarySeq} of the child's own log).`
	};
}

/** Signal-first classification of one engine failure; undefined means rethrow. */
function classifyEngineError(error, signal) {
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
	return undefined;
}

/** Map one wake-delivery failure from the manager to an honest outcome. */
function resumeRefusal(sessionId, error) {
	if (error instanceof Error && error.name === "ResumeCapacityTimeoutError") {
		return { outcome: "capacity-timeout", text: error.message };
	}
	if (error instanceof Error && error.name === "SubagentError") {
		switch (error.code) {
			case "UNAUTHORIZED":
				return { outcome: "not-authorized", text: `Session "${sessionId}" is not your direct runtime child; only its exact runtime parent may compact it.` };
			case "NOT_RESUMABLE":
				return { outcome: "not-resumable", text: `Session "${sessionId}" cannot be resumed: ${error.message}. Only continuable children with intact persisted state can be compacted after settlement.` };
			case "PERSISTENCE_UNAVAILABLE":
			case "CONTINUATION_UNAVAILABLE":
				return { outcome: "not-resumable", text: `This composition cannot resume settled children (${error.message}); only live children can be compacted here.` };
			case "ACTIVATION_CLOSING":
			case "DUPLICATE_CHILD":
			case "INPUT_CLOSED":
				return { outcome: "busy-target", text: `Subagent "${sessionId}" has live activity in flight (a continuation or another maintenance); retry shortly.` };
			default:
				return { outcome: "resume-failed", text: `Resuming subagent "${sessionId}" failed: ${error.message}` };
		}
	}
	return { outcome: "resume-failed", text: `Resuming subagent "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}` };
}

/**
 * Only a pre-start capacity rejection is safe to retry: no wake was accepted.
 * The host remains the admission authority; summary completion is not slot
 * release. Public ends (including other parents in a shared pool) are hints,
 * with a slow probe for rollback/increased limits that emit no end event.
 */
async function sendWhenCapacityAvailable(ctx, config, sessionId, signal, attempt, didStart) {
	let generation = 0;
	let wake;
	const offEnd = ctx.on("subagent/end", () => {
		generation += 1;
		wake?.();
	}, { global: true });
	let deadline;
	let lastError;
	try {
		while (true) {
			signal?.throwIfAborted();
			if (deadline !== undefined && performance.now() >= deadline) {
				const error = new Error(`Timed out after ${config.resumeCapacityTimeoutMs}ms waiting for capacity to resume subagent "${sessionId}"; no maintenance wake was accepted. ${lastError.message}`);
				error.name = "ResumeCapacityTimeoutError";
				throw error;
			}
			// Capture before admission, so an end during a rejected attempt is not lost.
			const before = generation;
			try {
				return await attempt();
			} catch (error) {
				if (signal?.aborted || didStart() || !(error instanceof Error) || error.name !== "SubagentError" || error.code !== "ACTIVATION_LIMIT_REACHED") throw error;
				lastError = error;
				deadline ??= performance.now() + config.resumeCapacityTimeoutMs;
			}
			if (generation !== before) continue;
			await new Promise((resolve, reject) => {
				let timer;
				let settled = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					wake = undefined;
					if (error !== undefined) reject(error);
					else resolve();
				};
				const onAbort = () => finish(signal.reason);
				wake = () => finish();
				if (signal?.aborted) { onAbort(); return; }
				signal?.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(wake, Math.max(1, Math.ceil(Math.min(CAPACITY_PROBE_MS, deadline - performance.now()))));
			});
		}
	} finally {
		offEnd();
	}
}

/**
 * Compact one of the caller's SETTLED continuable direct subagents by
 * resuming it through the normal continuation lifecycle, with the target's
 * per-session lock already held. A listener scoped to this session id is
 * registered BEFORE each admission attempt; `subagent/start` fires synchronously
 * once the manager has finished resume and ownership but before the message
 * is delivered, and the listener reserves the engine's maintenance window
 * right there by calling compactNow synchronously — never awaiting whenIdle
 * (the resume agent is idle at that edge) and never wrapping the engine in
 * another maintenance call. The wake message stays parked in the inbox while
 * the summary runs and is answered afterwards: compaction here is a real
 * extra exchange, not an offline transaction.
 *
 * @param ctx - plugin context carrying `agents`, `subagents`, events.
 * @param config - resolved plugin configuration.
 * @param caller - the exact live Agent authorizing the operation.
 * @param {string} sessionId - the settled child's shared agent/session id.
 * @param signal - cancellation scoped to this request.
 * @param sourceCommandId - initiating command identity, when command-invoked.
 * @returns outcome with `text`; `compacted` adds stats and the `resumed` mark.
 */
async function resumeAndCompactSubagent(ctx, config, caller, sessionId, signal, sourceCommandId) {
	const state = { fired: false, compaction: undefined, failure: undefined };
	const onStart = (info) => {
		if (state.fired || info?.id !== sessionId) return;
		state.fired = true;
		try {
			const agent = ctx.agents.get(sessionId);
			if (agent === undefined || !ctx.agents.isOwnedBy(sessionId, caller)) {
				state.failure = { outcome: "not-authorized", text: `Session "${sessionId}" did not resume under your runtime parentage; compaction was refused.` };
				return;
			}
			const resolvedEngine = resolveCompactionEngine(ctx, agent);
			if (!resolvedEngine.ok) {
				state.failure = { outcome: "engine-missing", text: resolvedEngine.reason };
				return;
			}
			state.compaction = resolvedEngine.engine.compactNow(agent, signal, sourceCommandId);
			/* Observe the rejection the moment the promise exists: the wake
			 * delivery below can still fail (or be cancelled inside the
			 * admission gap, after this job already launched), and an
			 * unobserved engine rejection would take down the process. */
			state.compaction.catch(() => {});
		} catch (error) {
			state.failure = { outcome: "error", text: `resume listener failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};
	let messageId;
	try {
		messageId = await sendWhenCapacityAvailable(ctx, config, sessionId, signal, async () => {
			// Listen only during admission, never while parked for capacity:
			// another actor's resume during that wait is not our start edge.
			const offStart = ctx.on("subagent/start", onStart);
			try { return await ctx.subagents.sendMessage(caller, sessionId, WAKE_MESSAGE, { signal }); }
			finally { offStart(); }
		}, () => state.fired);
	} catch (error) {
		/* The start edge may already have launched the engine job (a failure
		 * or cancellation inside the admission gap); converge it — its
		 * rejection is observed from the moment it existed — before this
		 * operation reports, so no engine promise outlives the call. */
		if (state.compaction !== undefined) await state.compaction.catch(() => {});
		if (signal !== undefined && signal.aborted) return { outcome: "cancelled", text: "Compaction cancelled." };
		return resumeRefusal(sessionId, error);
	}
	if (!state.fired) {
		/* No start edge: the target raced back live through another
		 * continuation, and the wake was delivered to that instance — the
		 * ordinary live path applies to it now. */
		if (ctx.agents.get(sessionId) !== undefined) {
			return compactLiveSubagent(ctx, config, caller, sessionId, signal, sourceCommandId);
		}
		return { outcome: "resume-failed", text: `Subagent "${sessionId}" accepted the wake message without a resume start edge or a live agent; nothing was compacted (the message stays delivered).` };
	}
	if (state.failure !== undefined) return state.failure;
	try {
		const result = await state.compaction;
		if (result === null) {
			return { outcome: "nothing-to-compact", resumed: true, text: `Resumed subagent "${sessionId}", but it has no compactable history yet. The wake message stays in the child's inbox and is answered by a normal turn.` };
		}
		const outcome = compactedOutcome(sessionId, result, "Resumed and compacted ");
		outcome.resumed = true;
		outcome.text += ` The wake message (${messageId}) stays in the child's inbox and is answered by a normal turn after the summary.`;
		return outcome;
	} catch (error) {
		const classified = classifyEngineError(error, signal);
		if (classified !== undefined) {
			classified.text += " The wake message stays delivered and is answered by a normal turn.";
			return classified;
		}
		throw error;
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

/**
 * Compact every still-live direct subagent in ONE durable catalog snapshot of
 * the calling parent: the snapshot is taken once at start (children spawned
 * afterwards belong to the next run) and ids are de-duplicated. All items
 * then run CONCURRENTLY — each live child parks on its own `whenIdle` immediately —
 * because a one-shot child is only compactable between its turn end and its
 * settlement reclamation: a serial batch that reaches a later child only
 * after finishing an earlier one can arrive after that child already
 * settled, and would silently skip a child the same window can still catch.
 * There is deliberately NO cap on live waits: queuing those would cause the
 * serial miss again. Settled children instead wait on host capacity rejection.
 * Per-target reentry locks and the shared fused signal
 * keep the items independent; one item's failure never hides the rest.
 *
 * Live children are compacted directly; settled continuable children are
 * resumed first (one real wake message each, see resumeAndCompactSubagent),
 * which is why every settled non-continuable entry reports skipped with its
 * mode instead of pretending to be compactable. Every other failure counts
 * against the item without hiding the rest.
 *
 * Outcomes: `completed` when at least one item compacted or had nothing to
 * compact and no item failed, was cancelled, or never started (skips do not
 * spoil the run); `nothing-compacted` when not a single target compacted —
 * the summary must never imply success there; `all-failed` when nothing
 * succeeded and something failed; `partial-failure` in between;
 * `empty-catalog` when the snapshot resolved empty; `listing-failed` when
 * the catalog read itself failed; `batch-cancelled` when the signal
 * aborted — an abort landing while the catalog read is still resolving
 * leaves the snapshot unknown, a snapshot that already resolved reports
 * every target not-started, and items already started each report their own
 * `cancelled`. Each compaction costs one summary request on the child's own
 * route, and each resume adds one wake-message turn after the summary.
 * Batch results are not persisted beyond the command result; a cancelled
 * invocation's per-item detail is dropped by the host's abort semantics.
 */
async function compactAllSubagents(ctx, locks, config, caller, signal, sourceCommandId) {
	let entries;
	try {
		entries = await ctx.subagents.listChildren(caller.id, signal);
	} catch (error) {
		if (signal.aborted) {
			return { outcome: "batch-cancelled", kind: "error", text: "Batch compaction cancelled while the catalog read was still in flight; the catalog snapshot is unknown (it was never read).", total: 0 };
		}
		return { outcome: "listing-failed", kind: "error", text: `Batch catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, total: 0 };
	}
	const seen = new Set();
	const items = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		items.push(entry);
	}
	/* The catalog read may resolve past an abort (a host read can complete
	 * beyond its last abort checkpoint). The resolved snapshot — deduped —
	 * is kept: every known target is reported not-started; the concurrent
	 * fan-out below is never entered, because an abort that landed before
	 * any item started leaves nothing to cancel per-item. */
	if (signal.aborted) {
		const lines = items.map((item) => `${item.id}: not-started (batch cancelled before this child began)`);
		const summary = `Summary (batch-cancelled) — total ${items.length}: every known target not-started.`;
		return { outcome: "batch-cancelled", kind: "error", text: ["Batch compaction of the caller's direct-subagent snapshot:", ...lines, summary].join("\n"), total: items.length };
	}
	if (items.length === 0) {
		return { outcome: "empty-catalog", kind: "success", text: "(no direct subagents on record for this session; nothing to compact)", total: 0 };
	}
	const counts = { compacted: 0, resumed: 0, "nothing-to-compact": 0, skipped: 0, failed: 0, cancelled: 0, "not-started": 0 };
	/* Report lines are written back by catalog index, so completion order
	 * never shuffles the batch receipt. */
	const lines = new Array(items.length);
	await Promise.all(items.map(async (item, index) => {
		/* Settled non-continuable children (one-shot, external, unknown) can
		 * never be resumed for in-place compaction; say so instead of paying
		 * for a doomed wake. Live children go straight to the live path. */
		if (config.resumeInactive && ctx.agents.get(item.id) === undefined && item.mode !== "continuable") {
			counts.skipped += 1;
			lines[index] = `${item.id}: skipped — settled and not continuable (mode: ${item.mode}); only continuable children can be resumed for compaction`;
			return;
		}
		let result;
		try {
			result = await compactSubagent(ctx, locks, config, caller, item.id, signal, sourceCommandId);
		} catch (error) {
			result = { outcome: "error", text: `unexpected error: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (result.outcome === "compacted") counts.compacted += 1;
		else if (result.outcome === "nothing-to-compact") counts["nothing-to-compact"] += 1;
		/* Settled children that cannot come back are expected skips. */
		else if (result.outcome === "not-resident" || result.outcome === "not-resumable") counts.skipped += 1;
		else if (result.outcome === "cancelled") counts.cancelled += 1;
		else counts.failed += 1;
		/* resumed counts only children that compacted after a resume, so the
		 * summary's "compacted N (R after resume)" stays a true subset; a
		 * resumed child with nothing to compact is visible in its own line. */
		if (result.outcome === "compacted" && result.resumed === true) counts.resumed += 1;
		if (result.outcome === "compacted") {
			lines[index] = `${item.id}: ${result.resumed === true ? "resumed from settled state and " : ""}compacted — replaced ${result.replacedItems} items (~${result.replacedTokens} tokens; summary at session-seq ${result.summarySeq})`;
		} else if (result.outcome === "not-resident") {
			lines[index] = `${item.id}: skipped — no longer live (already settled; compactable only while resident)`;
		} else if (result.outcome === "not-resumable") {
			lines[index] = `${item.id}: skipped — not resumable (${result.text})`;
		} else if (result.outcome === "nothing-to-compact") {
			lines[index] = `${item.id}: ${result.resumed === true ? "resumed, " : ""}nothing to compact`;
		} else {
			lines[index] = `${item.id}: ${result.outcome} — ${result.text}`;
		}
	}));
	const clean = counts.compacted + counts["nothing-to-compact"];
	let outcome;
	if (signal.aborted) outcome = "batch-cancelled";
	else if (clean > 0 && counts.failed === 0 && counts.cancelled === 0 && counts["not-started"] === 0) outcome = "completed";
	else if (clean > 0) outcome = "partial-failure";
	else if (counts.failed > 0) outcome = "all-failed";
	/* Nothing was compacted at all — every target was skipped or worse.
	 * Never let a summary line imply success here. */
	else outcome = "nothing-compacted";
	const summary = `Summary (${outcome}) — total ${items.length}: compacted ${counts.compacted}${counts.resumed > 0 ? ` (${counts.resumed} after resume)` : ""}, nothing-to-compact ${counts["nothing-to-compact"]}, skipped ${counts.skipped}, failed ${counts.failed}, cancelled ${counts.cancelled}, not-started: ${counts["not-started"]}.`;
	const text = ["Batch compaction of the caller's direct-subagent snapshot (live children compacted directly; settled continuable children resumed first):", ...lines, summary].join("\n");
	return { outcome, kind: batchCommandKind(outcome), text, total: items.length };
}

/** Expected outcomes the command reports as success rather than error. */
function commandKind(outcome) {
	return outcome === "compacted" || outcome === "nothing-to-compact" ? "success" : "error";
}

/** Batch outcomes the command reports as success rather than error: anything with a failed, cancelled, or not-started child — or a run that compacted nothing at all — is an error. */
function batchCommandKind(outcome) {
	return outcome === "completed" || outcome === "empty-catalog" ? "success" : "error";
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
			if (parts[0] === "all" || parts[0] === "--all") {
				if (parts.length > 1) return { kind: "error", text: `${USAGE} ("all" takes no other arguments)` };
				return compactAllSubagents(ctx, locks, config, invocation.agent, signal, invocation.commandId);
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
		description: "Compact the older history of one of your direct subagents into a summary so the child frees context while staying usable. Works on a still-live child, or resumes a settled continuable child by id first (one real wake message). Use an id from your subagent catalog. Reports how many history items were replaced and where the summary landed in the child's own session log.",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "Session id of your direct subagent to compact (live, or settled continuable — it gets resumed first)."
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
					replaced_tokens: { type: "number" },
					resumed: { type: "boolean" }
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
				...result.outcome === "compacted" ? {
					target_session_id: result.targetSessionId,
					summary_seq: result.summarySeq,
					replaced_items: result.replacedItems,
					replaced_tokens: result.replacedTokens,
					...(result.resumed === true ? { resumed: true } : {})
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
			description: "List direct subagents, compact them all in one run (settled continuable children are resumed first), or compact one by id",
			/* Desktop's command UI only claims a NON-bare invocation (arguments
			 * present) when the definition declares `input`; without it the line
			 * falls through as a plain user message
			 * (dsh-client-ui-commands/lib/client.js claim: `desc.input !== void 0`,
			 * else `if (!bare) return void 0`). Official exemplar: /goal. */
			input: {
				hint: "[all | <subagent-session-id>]"
			},
			handler: commandHandler(ctx, locks, resolved, active)
		});
		const unregisterTool = ctx.tools.register(subagentCompactTool(ctx, locks, resolved, active));
		yield () => unregisterTool();
	}, "subagent-compactor lifecycle");
}

export { apply, inject, name, Config };
