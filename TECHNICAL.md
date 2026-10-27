# @local/dsh-subagent-compactor

Manual history compaction for one of the caller's **direct subagents** — live, or a continuable child restored by id after it finished — reusing the composition's own compaction engine (e.g. `@deepseek-ai/dsh-compaction-basic`). Built and reviewed against DSH Harness 0.2.1-rc.2 (DSH Desktop 0.12.1).

## What you get

- **`/subagent-compact`** (chat command)
  - No arguments: lists the calling session's durable direct-subagent catalog (`session id [mode] label — live|persisted (not loaded)`), via `ctx.subagents.listChildren` plus a live-registry lookup. A listing is an observation, not a reservation.
  - One session id: compacts that direct child — live, or persisted continuable.
- **`compact_subagent`** (model tool) — the same operation from inside a model turn; takes `session_id` and returns `{ outcome, target_session_id, summary_seq, replaced_items, replaced_tokens }` with a text render.

Both surfaces serialize per target: one compaction per session id at a time inside this plugin (`busy-target` on contention).

## Two paths, one operation

**Live target** (`agents.get(id)` present): authorization stays runtime ownership (`agents.isOwnedBy(id, caller)`), `waitForIdle` (default `true`) bridges a running turn into the engine, and the registry identity is re-checked after the wait (a same-id replacement agent is a different object).

**Persisted target** (no live agent): the cold path, mirroring the subagent manager's own continuation reconstruction (`coldResume`) step for step through public APIs only:

1. `sessionQuery.observeSession(id)` reads the persisted snapshot; absence is `unknown-session`, never a guess.
2. The exact calling Agent must still be live; the target's authoritative persisted header must name the caller as `parentSession` (`not-authorized` otherwise — this is what refuses foreign parents and grandchildren; a catalog record alone is never authorization).
3. The child's **own** events (`events.slice(inheritedEventCount)` — a fork's inherited prefix is not the child's) must fold to a supported `subagent/descriptor` (`foldSubagentDescriptor`, version 3, mode `continuable`); one-shot records, external sessions, missing/malformed/unsupported descriptors are `unsupported-target`.
4. An independent preset selection (`agent-preset/selected` before the descriptor) must resolve to a current preset id through the session's `agentPreset` projection, or restoration fails explicitly (`restore-failed`).
5. **Durable pending input is checked before anything is materialized** (`inbox` projection: `next-turn` + `next-step`). A restored handle's disposal durably cancels parked inbox input, so a child with pending work is refused (`pending-input`) and that work survives for a normal continuation. An unverifiable inbox (no projection) also refuses.
6. The child is restored through public `agents.resume({ resumeSessionId, parentAgent: caller, agentOptions, setup })` with exactly the descriptor's optional route fields (`agentProvider`/`agentModel`/`agentReasoningEffort`; the resumed route's defaults apply where the descriptor omitted them — never the parent's current route, never activation-only knobs like `outputSchema`/`maxTokens`). The setup applies the official `applyChildComposition(childCtx, caller, { agentPreset, persona, toolFilter })` and returns void (no preset mount receipt leaks as a setup commit object).
7. `compactNow(agent, signal, commandId)` runs in the idle maintenance window; the six-code error contract is unchanged; the observation lease and the restored handle are always released (`release-failed` reports a committed compaction whose release did not converge).

## Engine resolution (two lawful planes, no fallback)

- With an `agentPresets` registry (Desktop/Web presets): the engine is published inside the preset's **isolated** group, so it is resolved strictly via `agentPresets.serviceFor(target, 'compaction')` — for a cold-restored child, after its composition is applied in resume setup. A plain context lookup (including `agent.ctx`) would resolve the Host realm instance, which is not the engine that owns the target's session — this plugin never does that fallback. A missing preset engine fails with an explicit message.
- Without a registry (headless/ACP-style compositions): the engine, when composed, is the Host-plane `compaction` service — the same source official `/compact` injects.

## Concurrency, message admission, and the release cutoff

Cold compaction runs through the host's manager-owned maintenance capability (`ctx.subagents.runMaintenance`, provided by the candidate patch in `host-patch/`; on a stock runtime the plugin refuses cold compaction with `host-capability-missing` and live-window compaction is unaffected):

- The child is restored exactly like a continuation and becomes **resident**, so every normal route (`sendMessage`, addressed `prompt({delivery:"queue"})`) delivers through the manager instead of colliding on the session writer — including while pending input keeps the activation resident, and including a close in flight (the delivery loop waits out a closing activation and retries).
- The engine's `compactNow` is the only maintenance window; the manager holds the settlement watcher back for the job's duration, so nothing reclaims the child mid-job.
- Afterwards the ordinary settlement takes over under a **loop-level admission cutoff**: `Agent.closeInput()` is checked synchronously at the single enqueue chokepoint (`send`), and the manager's `close()` sets `activation.closing` and the agent cutoff in one synchronous section. Input accepted before the cutoff is processed or durably preserved (the watcher refuses to settle while the inbox is non-empty; a `keepInbox` abort restores even a claimed-but-uncommitted batch); input after the cutoff is rejected before acceptance.
- Unloading only the plugin aborts the job; the host-side settlement still owns the activation, so parked input survives and the same id continues normally afterwards.

The plugin itself holds no restored handle at all — it cannot drop accepted input because it never owns the release. A per-target lock still serializes the plugin's own entry points (`busy-target`).## Error contract

All six `ManualCompactionError` codes map to distinct messages: `busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`; an unknown runtime code stays diagnosable (code + engine diagnostic) instead of throwing. Cancellation is decided by the request **signal first**, then the code — `compactNow` folds its own caught aborts into `busy`, so "the caller cancelled" is only decidable from the signal. Errors are matched by `name + code` (and, for peer errors like `SessionAlreadyOwnedError`, by chained `name`), never `instanceof`, because the plugin and the engine are not guaranteed to share a module tree. Cold-specific outcomes: `unknown-session`, `unsupported-target`, `pending-input`, `busy-target`, `restore-failed`, `query-unavailable`, `release-failed`. Unloading aborts in-flight operations and awaits them for at most 10 seconds; the restored handle is disposed in the operation's `finally`.

## Known boundaries

1. **Reported tokens are the replaced history's estimate.** `replaced_tokens`/`~N tokens` is the old shadowed span's estimated size — not net context savings. Measure before/after surface budget if you need savings. (The persisted event log itself only ever grows; shadowing is a surface operation.)
2. **No `sourceEventSeq` on the command result.** It would be written into the *parent* session's `command/done` event, where a bare child-session seq points at the wrong event; child session id + summary seq travel explicitly in the text and tool result instead.
3. **Listing needs `sessionQuery` + the `subagentCatalog` projection** (present in normal subagent-capable compositions); otherwise the no-arg command reports listing unavailable. Cold compaction needs `sessionQuery` and session persistence; live compaction does not.
4. **Each compaction costs one extra LLM call** for the summary, on the child's own restored route.
5. **Pending work is preserved.** A finished child whose durable pending is visible to the read precheck is refused (`pending-input`) so a normal continuation processes that work first; pending that only the loaded snapshot sees is preserved losslessly by the host lifecycle (the maintenance may proceed — its job never touches the inbox).
6. **No auto-compact-on-end.** Deliberately absent: in 0.2.1-rc.2 the subagent manager disposes the child's AgentHandle *before* emitting `subagent/end`, so an end-hook listener sees no live agent. The 1.1.0 cold path covers the same need by id after settlement.
7. **Hard injections** `commands`, `tools`, `agents`, `subagents`: in compositions without these services the row stays inactive instead of half-working. `agentPresets`/`compaction`/`sessionQuery` are resolved dynamically on purpose (see Engine resolution).
8. **Cold compaction needs the host maintenance capability.** On a stock 0.2.1-rc.2 runtime the plugin refuses cold compaction explicitly (`host-capability-missing`, see docs/HOST_MAINTENANCE_REQUIREMENTS.md); the isolated candidate patch in `host-patch/` provides it. Live-window compaction works on both.

## Install

Official flow only — no manual profile edits:

```
plugin_manager install_bundle  (target: this package directory)
```

Then confirm `application: applied` and the `subagent-compactor` row via `cordis_inspect_query Config.listConfigs`.

## Tests

`test/unit.test.mjs` drives this real module against stub contexts: six-code mapping, signal-first cancellation, both engine planes (incl. preset-missing and no-registry), ownership rejections, TOCTOU identity re-check, usage parsing, unload abort + bounded settle, the cold decision table (unknown-session, descriptor classes, lineage, pending refusal, preset projection failure and mount, `SessionAlreadyOwnedError` → `busy-target`, per-target lock, release-failure demotion, aborted restore), and the live/persisted listing split.

`test/integration.test.mjs` composes **real DSH modules** from the installed tree and proves the live-window journey end to end (settlement/reclaim; cold resume by message; compact during a running request; surface shrink; persistence; follow-up; foreign-parent denial in a live window).

`test/cold.integration.test.mjs` proves the 1.1.0 cold journeys against real modules: cold-by-id success and release; concurrent sends failing before acceptance with retry delivered once; real foreign/grandchild denial; synthetic descriptor/lineage fixtures; persisted-pending refusal with the work preserved and later processed; same-id contention; cancellation and summary failure with release and continuation; a preset-registry composition restoring an independent child preset and child model with no Host fallback.

Run from this directory with `node_modules` linked to a DSH 0.2.1-rc.2 module tree:

```
node --test test/unit.test.mjs
node --test test/integration.test.mjs   # boots real compositions; ~seconds
node --test test/cold.integration.test.mjs
```

## Scope (v1.1)

List + manual compact of direct children (live or finished continuable), by command or tool. Not included: UI, member deletion/handoff, auto-compact triggers, one-shot/external cold compaction.
