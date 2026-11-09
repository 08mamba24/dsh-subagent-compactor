# Technical contract: 1.2.0 live-only compaction

This branch compacts the caller's **live runtime-owned direct children** through the child's existing compaction engine. Its tested runtime is stock Harness `0.2.2-rc.1`. Plugin installation and enablement are sufficient on that runtime; the legacy host maintenance patch is not part of this implementation.

## Entry points

| Entry point | Operation |
| --- | --- |
| `/subagent-compact` | Read the caller's durable direct-child catalog and mark each entry `live` or `persisted (not loaded)` |
| `/subagent-compact <id>` | Compact one live direct child |
| `/subagent-compact all` or `--all` | Compact live direct children from one catalog snapshot concurrently |
| `compact_subagent({session_id})` | Run the single-child operation from a model turn |

The model tool returns `text` and `outcome`; success also includes `target_session_id`, `summary_seq`, `replaced_items`, and `replaced_tokens`. There is no batch model tool, report command, cold restore path, or plugin batch-receipt domain in this version.

## Single-child path and authorization

1. Acquire the plugin's per-target lock. A competing single or batch operation on the same ID returns `busy-target`.
2. Resolve the live agent through `agents.get(id)`. An unloaded or reclaimed target returns `not-resident`.
3. Require `agents.isOwnedBy(id, caller)`. The runtime registry checks the exact parent Agent object; a persisted catalog entry alone grants no authority. Self, foreign children, and grandchildren return `not-authorized`.
4. Resolve the child's compaction engine as described below.
5. With `waitForIdle: true` (the default), wait for `agent.whenIdle()` with the request's cancellation signal.
6. Recheck that `agents.get(id)` is still the same Agent object after the wait. Disposal or same-ID replacement returns `not-resident`.
7. Call `engine.compactNow(agent, signal, sourceCommandId)` and render its result. A null result means `nothing-to-compact`.
8. Release the per-target lock in `finally`.

The plugin never restores a persisted session. A normal message may make a previously settled child live again; compaction can then use that new live instance. Calling while a request is still running lets the idle wait bridge the turn end into compaction, before settlement reclaims the child.

## Engine resolution

There are two composition modes:

- **Preset registry present (Desktop/Web):** use `agentPresets.serviceFor(target, "compaction")`. The engine belongs to the child's isolated preset group. A missing preset engine is `engine-missing`; the plugin does not fall back to a different engine in the Host realm.
- **No preset registry:** use the composed Host-plane `compaction` service, as the official `/compact` command does. A missing service is `engine-missing`.

This is service lookup into the stock runtime, not a replacement compaction implementation or a host patch. Summary requests follow the child's own model route.

## Batch scheduling and outcomes

The batch reads `subagents.listChildren(caller.id, signal)` once and de-duplicates IDs, retaining catalog order. The catalog is durable and can include settled children; residency and runtime ownership are checked independently for every attempt. Children created after the snapshot are excluded.

Every item starts concurrently and immediately enters the same single-child path. This matters because one child's summary can take longer than another child's remaining live window. Serial scheduling or a concurrency queue could arrive after a later child has already been reclaimed. There is no concurrency cap; model rate-limit failures are reported per item.

Results are assigned by catalog index, so completion order does not reorder the output. Each child contributes `compacted`, `nothing-to-compact`, `skipped` for `not-resident`, `cancelled`, or `failed`. Unexpected errors become that item's failure and do not hide other results.

| Batch outcome | Meaning | Command kind |
| --- | --- | --- |
| `completed` | No item failed, was cancelled, or remained not-started; skips are allowed, including an all-skipped run | Success |
| `empty-catalog` | The snapshot contained no children | Success |
| `partial-failure` | At least one item compacted or had nothing to compact, and another failed | Error |
| `all-failed` | Failures occurred and no item compacted or had nothing to compact | Error |
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

See [docs/VALIDATION.md](docs/VALIDATION.md) for the 46-test installed-runtime and clean npm runs, isolated bundled Web UI journey, and limits on that evidence.
