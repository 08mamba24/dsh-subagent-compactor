# @local/dsh-subagent-compactor

Manual history compaction for one of the caller's **live direct subagents**, reusing the composition's own compaction engine (e.g. `@deepseek-ai/dsh-compaction-basic`). Built and reviewed against DSH Harness 0.2.1-rc.2 (DSH Desktop 0.12.1).

## What you get

- **`/subagent-compact`** (chat command)
  - No arguments: lists the calling session's durable direct-subagent catalog (`session id [mode] label`), via `ctx.subagents.listChildren`.
  - One session id: compacts that live direct child, e.g. `/subagent-compact 3f0c…`.
- **`compact_subagent`** (model tool) — the same operation from inside a model turn; takes `session_id` and returns `{ outcome, target_session_id, summary_seq, replaced_items, replaced_tokens }` with a text render.

Both surfaces wait for a busy child to become idle first (`waitForIdle`, default `true`), re-check the child's live identity after the wait, then call `engine.compactNow(agent, signal, sourceCommandId)`.

## Engine resolution (two lawful planes, no fallback)

- With an `agentPresets` registry (Desktop/Web presets): the engine is published inside the preset's **isolated** group, so it is resolved strictly via `agentPresets.serviceFor(target, 'compaction')`. A plain context lookup (including `agent.ctx`) would resolve the Host realm instance, which is not the engine that owns the target's session — this plugin never does that fallback. A missing preset engine fails with an explicit message.
- Without a registry (headless/ACP-style compositions): the engine, when composed, is the Host-plane `compaction` service — the same source official `/compact` injects.

## Authorization

Only the exact **runtime** direct parent may compact: every entry checks `agents.isOwnedBy(childId, caller)` (`store.get(id)?.owner === owner`). This rejects other agents' children (IDOR), the caller compacting itself, and grandchildren, regardless of persisted lineage or id reuse.

## Error contract

All six `ManualCompactionError` codes map to distinct messages: `busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`; an unknown runtime code stays diagnosable (code + engine diagnostic) instead of throwing. Cancellation is decided by the request **signal first**, then the code — `compactNow` folds its own caught aborts into `busy`, so "the caller cancelled" is only decidable from the signal. Errors are matched by `name + code`, never `instanceof`, because the plugin and the engine are not guaranteed to share a module tree. Unloading aborts in-flight operations and awaits them for at most 10 seconds.

## Known boundaries

1. **Live children only, and the window has timing semantics.** A child is compactable while it is live: once a run truly settles, the settlement watcher reclaims the child and the command fails explicitly (`not-resident`). The deterministic path is to invoke while the child is running a request — `waitForIdle` bridges the turn end into the engine (integration-proven). Re-waking the same child id later (e.g. `sendMessage`) cold-resumes it from persistence as a fresh live agent and reopens the window; this version does not compact settled/cold children directly (resume→compact→dispose would risk clearing parked inbox messages per the loop's dispose cancel semantics).
2. **Reported tokens are the replaced history's estimate.** `replaced_tokens`/`~N tokens` is the old shadowed span's estimated size — not net context savings. Measure before/after surface budget if you need savings.
3. **No `sourceEventSeq` on the command result.** It would be written into the *parent* session's `command/done` event, where a bare child-session seq points at the wrong event; child session id + summary seq travel explicitly in the text and tool result instead.
4. **Listing needs `sessionQuery` + the `subagentCatalog` projection** (present in normal subagent-capable compositions); otherwise the no-arg command reports listing unavailable. Compact itself does not need them.
5. **Each compaction costs one extra LLM call** for the summary, on the child's routed model.
6. **No auto-compact-on-end.** Deliberately absent: in 0.2.1-rc.2 the subagent manager disposes the child's AgentHandle *before* emitting `subagent/end`, so an end-hook listener sees no live agent — an `onEnd` option would be a structural no-op (feature theater). If DSH later offers a pre-disposal hook, revisit.
7. **Hard injections** `commands`, `tools`, `agents`, `subagents`: in compositions without these services the row stays inactive instead of half-working. `agentPresets`/`compaction`/`sessionQuery` are resolved dynamically on purpose (see Engine resolution).

## Install

Official flow only — no manual profile edits:

```
plugin_manager install_bundle  (target: this package directory)
```

Then confirm `application: applied` and the new `subagent-compactor` row via `cordis_inspect_query Config.listConfigs`.

## Tests

`test/unit.test.mjs` drives this real module against stub contexts: six-code mapping, signal-first cancellation, both engine planes (incl. preset-missing and no-registry), ownership rejections, not-resident, TOCTOU identity re-check, usage parsing, unload abort + bounded settle.

`test/integration.test.mjs` composes **real DSH modules** from the installed asar (session persistence in a temp dir, token meter, compaction-basic, agent loop, subagent + spawn provider, commands/tools, a local Anthropic-Messages-compatible fake LLM server) and proves end-to-end: a real continuable child runs its activation to true settlement and is then reclaimed (late command fails explicitly `not-resident`); re-waking the same child id cold-resumes a fresh live agent, and invoking `/subagent-compact` while that request is running waits for the turn to end and compacts through the real engine (measured surface shrinks, summary events reach the session log and the jsonl persistence); afterwards the child still answers a later message (instance-independent waiting, message preservation), and a foreign parent is rejected on a live child.

Run from this directory with `node_modules` linked to a DSH 0.2.1-rc.2 module tree:

```
node --test test/unit.test.mjs
node --test test/integration.test.mjs   # boots a real composition; ~seconds
```

## Scope (v1)

List + manual compact of live direct children, by command or tool. Not included: UI, member deletion/handoff, cold-resume compaction, auto-compact triggers.
