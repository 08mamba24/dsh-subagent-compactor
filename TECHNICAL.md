# Technical contract: 1.3.3 rc.1/rc.2 compatibility candidate

This branch compacts the caller's **runtime-owned direct children** through the child's existing compaction engine — live children directly, and settled continuable children by resuming them through the normal continuation lifecycle first. Its module-level test runtimes are stock Harness `0.2.2-rc.1` and `0.2.2-rc.2`; the candidate is local and awaits independent review. Plugin installation and enablement are sufficient on that runtime; the legacy host maintenance patch is not part of this implementation.

## Entry points

| Entry point | Operation |
| --- | --- |
| `/subagent-compact` | Read the caller's durable direct-child catalog and mark each entry `live` or `persisted (not loaded)` |
| `/subagent-compact <id>` | Compact one direct child — live directly, settled continuable via resume |
| `/subagent-compact all` or `--all` | Compact every child from one catalog snapshot concurrently — live directly, settled continuable via resume |
| `compact_subagent({session_id})` | Run the single-child operation from a model turn |

The model tool returns `text` and `outcome`; success also includes `target_session_id`, `summary_seq`, `replaced_items`, `replaced_tokens`, and `resumed: true` when a resume happened first. There is no batch model tool, report command, host-patch cold restore path, or plugin batch-receipt domain in this version.

## Single-child path and authorization

1. Acquire the plugin's per-target lock. A competing single or batch operation on the same ID returns `busy-target`.
2. Resolve the live agent through `agents.get(id)`. A live target takes the live path below; a settled target takes the resume path (next section) when `resumeInactive` is on (the default), and otherwise returns `not-resident`.
3. Apply the shared direct-parent policy. rc.1 retains `agents.isOwnedBy(id, caller)`. rc.2 first requires the exact live caller and a target in its direct catalog, then checks the exact caller/target Agent objects through the manager's `subagents.rootOf`. Both must still belong to the captured runtime root. A catalog alone or a shared root alone grants no authority. Self, foreign children, unmanaged instances, and grandchildren return `not-authorized`. Cold rc.2 targets pass the catalog gate before any wake is sent.
4. Resolve the child's compaction engine as described below.
5. With `waitForIdle: true` (the default), wait for `agent.whenIdle()` with the request's cancellation signal.
6. Recheck both runtime authorization and that `agents.get(id)` is still the same Agent object after the wait. A true reclamation (no live agent at all) falls through to the capacity-aware resume path; a same-ID replacement *object* still refuses with `not-resident` — the stale handle must not be compacted.
7. Call `engine.compactNow(agent, signal, sourceCommandId)` and render its result. A null result means `nothing-to-compact`.
8. Release the per-target lock in `finally`.

Calling while a request is still running lets the idle wait bridge the turn end into compaction, before settlement reclaims the child.

## Settled-child resume path

A settled continuable child is compacted through the host's own continuation lifecycle — no host patch, no private maintenance API:

1. Every admission attempt first checks for a live target; an externally restored Agent takes the existing live path without a wake. Otherwise a `subagent/start` listener scoped to this one target ID is registered **before each admission attempt**. On rc.2 the listener checks `parentSessionId === caller.id`, target ID, a local activation with a nonempty run ID, and the exact runtime Agent/root; one edge can reserve maintenance only once. It accepts an own start edge only in this send attempt's AsyncLocalStorage scope and is removed when that attempt returns or throws. It is absent while waiting for capacity, so another actor's resume during that wait cannot launch an orphan summary.
2. The plugin calls the ordinary `subagents.sendMessage(caller, id, WAKE_MESSAGE, { signal: sendSignal })`. The manager performs the cold resume under its own admission, ownership, preset restoration, and model routing — the plugin claims no authority beyond the caller's own parenthood. A refused wake maps the host's `SubagentError` code: `UNAUTHORIZED` → `not-authorized`; `NOT_RESUMABLE`/`PERSISTENCE_UNAVAILABLE`/`CONTINUATION_UNAVAILABLE` → `not-resumable`; `ACTIVATION_CLOSING`/`DUPLICATE_CHILD`/`INPUT_CLOSED` → `busy-target`; anything else → `resume-failed`.
3. `subagent/start` fires synchronously once the manager has finished resume and ownership but **before the message is delivered**. At that edge the resumed agent is registered (`agents.get`), owned by the caller, and idle — the factory's initialization maintenance has already finished. The listener therefore calls `engine.compactNow(agent, signal, sourceCommandId)` **synchronously inside the edge**, reserving the engine's maintenance window before the listener returns. Awaiting `whenIdle` first is wrong here (the agent is idle already; on the earlier `agent/created` edge it would deadlock), and wrapping the engine in another maintenance call is wrong too — the probe for this timing is preserved with the acceptance records.
4. The operation joins the compaction promise. The wake message stays parked in the child's inbox during the summary and is answered by one normal turn afterwards, which is why compaction here is a real extra exchange: if the summary fails, the delivered message still runs, and every failure receipt says so explicitly.
5. The host child lock can queue this send behind another cold resume even after a non-live precheck. A matching start in a different async scope cancels only a per-attempt delivery controller, leaving the caller/unload signal and the external task intact. Once that send rejects with this local cancellation reason, the captured Agent takes the ordinary live path; its identity and runtime ownership are rechecked. Caller cancellation and unrelated errors take precedence. A changed or reclaimed Agent returns `not-resident`, without a recursive resume. A send accepted without any start edge retains the existing live fallback or explicit `resume-failed` outcome.
6. The wake text is fixed: it asks for a single maintenance acknowledgment and explicitly forbids starting new work. It is the only message this plugin ever sends.

Node AsyncLocalStorage supplies causal attribution for the start listener; it does not supply authorization. The engine always receives the original fused request signal, never the per-attempt delivery signal. Stock Harness checks that delivery signal under the child lock immediately before accepting a message, which prevents a wake queued behind a foreign restoration from entering the external task. No host internals are mutated.

### Capacity backpressure

Only `SubagentError` with code `ACTIVATION_LIMIT_REACHED`, before a matching start edge, waits and retries. Such a rejection has not accepted a wake. Every retry either uses the now-live Agent without a message or goes through the same public `sendMessage` admission; the plugin neither guesses slots from the direct catalog nor changes the host limit. Errors after a start edge, ownership refusals, missing capabilities, and summary errors remain terminal outcomes.

Before the first attempt, the operation subscribes to public `subagent/end` with `{ global: true }`. A release in the shared pool can come from another parent or a descendant outside this snapshot. On the tested stock rc.1/rc.2 runtimes, slot release follows handle disposal and precedes this event. `agent/disposed` and summary completion happen too early to prove admission capacity. An event is only a hint: competing batches still have to pass host admission.

A generation captured before each attempt detects an end arriving before its rejection is observed. Otherwise the operation sleeps until an end, cancellation, or a one-second probe. The probe covers unpublished materialization rollback and dynamic host-capacity changes, which need not emit an end. There is no per-target FIFO guarantee across competing commands; the host arbitrates each attempt.

`resumeCapacityTimeoutMs` defaults to 120000, accepts integer values from 1 through 600000, and starts at the first capacity rejection. It bounds capacity waiting, including nested callers whose own activation may keep their shared pool full. Expiry returns `capacity-timeout` with the host's last diagnostic and the fact that no maintenance wake was accepted. Successful admission removes the event listener and capacity timer; the budget never aborts a later summary or acknowledgment turn. An already-entered host admission still follows the caller's signal and host cancellation contract.

Waiting remains inside the existing per-target lock and uses the caller/unload fused signal for single-ID commands, the tool, and batches. Cancellation removes the capacity wait and listeners, prevents further attempts, and releases the lock. The plugin never ends a working activation to make room.

## Engine resolution

There are two composition modes:

- **Preset registry present (Desktop/Web):** use `agentPresets.serviceFor(target, "compaction")`. The engine belongs to the child's isolated preset group. A missing preset engine is `engine-missing`; the plugin does not fall back to a different engine in the Host realm.
- **No preset registry:** use the composed Host-plane `compaction` service, as the official `/compact` command does. A missing service is `engine-missing`.

This is service lookup into the stock runtime, not a replacement compaction implementation or a host patch. Summary requests follow the child's own model route.

## Batch scheduling and outcomes

The batch reads one direct-child snapshot and de-duplicates IDs, retaining catalog order. rc.1 uses `subagents.listChildren(caller.id, signal)`; rc.2 observes the parent Session with `sessionQuery.observeSession(caller.id, {signal})`, copies `projections.values.subagentCatalog`, and disposes the observation in `finally`. Missing projections, malformed rows, and diagnostic-shaped rows fail discovery explicitly. It never enumerates descendants or silently ignores a branch diagnostic. The catalog is durable and can include settled children; residency and runtime ownership are checked independently for every attempt. Children created after the snapshot are excluded.

Every item starts concurrently and immediately enters the same single-child path. All live idle waits are registered immediately: one child's summary can take longer than another child's remaining live window. Settled targets wait only when actual host admission rejects for capacity. A blocked resume never queues a live idle wait behind it. Model rate-limit failures are reported per item.

Results are assigned by catalog index, so completion order does not reorder the output. Each child contributes `compacted` (marked and counted when it needed a resume first), `nothing-to-compact`, `skipped` for `not-resident` or `not-resumable`, `cancelled`, or `failed`. Settled non-continuable entries (one-shot, external, unknown) are skipped up front with their mode — no wake is paid for a child that can never resume. Unexpected errors become that item's failure and do not hide other results.

| Batch outcome | Meaning | Command kind |
| --- | --- | --- |
| `completed` | At least one item compacted or had nothing to compact, and no item failed, was cancelled, or remained not-started; skips are allowed | Success |
| `empty-catalog` | The snapshot contained no children | Success |
| `partial-failure` | At least one item compacted or had nothing to compact, and another failed | Error |
| `all-failed` | Failures occurred and no item compacted or had nothing to compact | Error |
| `nothing-compacted` | Not a single target compacted — every item was skipped; the summary must never imply success | Error |
| `listing-failed` | Catalog discovery failed | Error |
| `batch-cancelled` | The request signal was aborted | Error |

If cancellation happens before the catalog resolves and its read rejects, the snapshot is unknown. If the read resolves after cancellation, known targets are reported `not-started` and no item begins. After fan-out, started operations observe the shared cancellation signal and report their own outcomes.

Batch output is only the command result. The plugin writes no separate receipt store and exposes no `report` operation. The host may discard the command result on abort, including per-item details. This limitation concerns the batch output; successfully committed child summaries use the host's ordinary session persistence.

## Error and cancellation contract

The six `ManualCompactionError` codes remain distinct: `busy`, `cancelled`, `changed`, `summary`, `commit`, and `persistence`. Unknown runtime codes return `unknown-code` with the original code and diagnostic. Errors match `name` and `code`, avoiding cross-package `instanceof` assumptions.

The request signal is authoritative for cancellation. The engine can fold a caught abort into `busy`, so the plugin checks `signal.aborted` before interpreting an engine error. Single-child command success is limited to `compacted` and `nothing-to-compact`; other outcomes return an error result.

Each listing or compaction operation has a controller combined with the caller's signal. During plugin unload, registrations go offline, all active operations are aborted, and cleanup waits for settlement for at most 10 seconds. The plugin owns no restored handle and performs no cold-session disposal.

## Persistence and measurements

The child engine owns summary commits and history shadowing. `replaced_items` counts the old history items shadowed by the summary, and `replaced_tokens` estimates that old span. Neither field measures net context savings. The persisted event log can grow while the model-facing context shrinks.

Command results identify the child session and its summary sequence explicitly. They omit `sourceEventSeq`: a child sequence written as the source of the parent's `command/done` event would refer to the wrong session.

## Composition requirements and scope

`commands`, `tools`, `agents`, and `subagents` are required injections. `agentPresets` and `compaction` are resolved dynamically to select the correct engine. Catalog listing also relies on `sessionQuery` and the `subagentCatalog` projection provided by normal subagent-capable compositions; a missing catalog produces an explicit listing error. Single-child live compaction does not require catalog discovery.

Scope is manual live-child compaction. Automatic end hooks, member deletion, handoff, and direct compaction of settled sessions are absent. The files in [host-patch/](host-patch/README.md), [COLD_COMPACTION_PLAN.md](docs/COLD_COMPACTION_PLAN.md), and [HOST_MAINTENANCE_REQUIREMENTS.md](docs/HOST_MAINTENANCE_REQUIREMENTS.md) describe only the older unreleased 1.1.0 candidate. Its cold APIs, `compact_all_subagents` tool, report syntax, and durable batch receipts do not apply to this branch.

## Verification

The four tracked suites cover the single-child contract, concurrent batches, real runtime integration, and preset engine lookup. Run them with Node 24.9.0 or newer:

```sh
npm ci --include=dev
npm test
```

See [docs/VALIDATION.md](docs/VALIDATION.md) for the current 92-test npm run, the 16-target capacity regression, historical installed-runtime runs, settle-and-resume evidence, isolated bundled Web UI journey, and limits on that evidence.
