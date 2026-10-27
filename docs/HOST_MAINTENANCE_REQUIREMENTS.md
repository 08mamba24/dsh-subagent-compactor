# Host maintenance capability requirements for cold subagent compaction

Status: **implemented as an isolated candidate patch** (plugin branch `feature/cold-session-compaction`, review round 4). The capability below exists as a minimal host change — TypeScript source diff plus an equivalent compiled-tree patch under `host-patch/`, verified in an isolated module tree; no installed artifact, shared evidence tree, or real profile is modified. The published plugin does NOT depend on it: on the currently verified public combination (stock 0.2.1-rc.2) there is no implementation satisfying the full contract, and the plugin refuses cold compaction explicitly there.

Runtime under discussion: DSH Harness **0.2.1-rc.2** (DSH Desktop 0.12.1). Acceptance contract (from independent review):

1. **Accepted input is never lost** — a message any public surface accepted during the cold maintenance window is either fully processed (durable `user/message` + assistant answer) or preserved as durable pending; it is never silently cancelled or claimed-then-aborted.
2. **Normal continuation stays available** — every normal route (`subagents.sendMessage`, addressed `subagents.prompt` with `delivery: "queue"`) can reach the child throughout, or fails cleanly *before acceptance* at a published cutoff.
3. **Unload loses nothing** — unloading the plugin releases its hold without durably cancelling parked input.

## Where the stock public surface stands, step by step

| Step | Stock 0.2.1-rc.2 public capability | Verdict |
| --- | --- | --- |
| Restore + composition rebuild by id | `sessionQuery.observeSession`, `foldSubagentDescriptor`, `agentPreset` projection, `agents.resume` + `applyChildComposition` | ✅ implemented in this plugin |
| Execute one maintenance job on the restored child | `agent.runMaintenance` / `engine.compactNow` | ✅ implemented |
| **Shared admission/release cutoff** | Only the manager has one: `activation.closing` set synchronously at `close()` entry, checked by `deliver()`. The generic Agent's public `followup`/`steer`/`inject` have **no freeze**; the plugin's check-then-dispose window accepts and then drops input (review R2 proof 1) | ❌ gap A |
| **Lossless release** | `AgentHandle.dispose` → teardown `machine.cancel({kind:"disposed"})` unconditionally cancels a non-empty inbox; no `keepInbox` option exists | ❌ gap B |
| **Normal routes reach a restored child** | Manager delivery requires a **resident activation**. A generic `agents.resume` handle is not resident, so `sendMessage`/`prompt` take `coldResume` → `persistence.open(write)` → `NOT_RESUMABLE` while the handle holds the writer (review R2 proof 2) | ❌ gap C |
| **Lossless unload** | Same teardown as gap B; the manager's own drain-stop (`finishDisposal(stop=true)` → `cancel({kind:"parent"})`) also clears the inbox (review R2 proof 3) | ❌ gap D |

**Root cause:** for a generic resume, restore, input admission, maintenance, and release have **no single owner**. The only mechanism in the host that owns all four is the manager's resident Activation lifecycle (`deliver` admission with `ACTIVATION_CLOSING`/`INPUT_CLOSED`, `watchLocalSettlement` waiting while `inbox` is pending, `runMaintenance`-based close, `finishDisposal`). The plugin cannot reach it: `materialize` is private, and every public entry that creates an activation also submits an ordinary task.

## Implemented candidate (host-patch/)

Everything in the proposal below is realized by the candidate patch at `host-patch/` (source baseline `dsh-v0.2.1-rc.2` = `687f282e8625c6b8d11ff58211a90524be2e4317`), including the round-3 corrections: the engine's `compactNow` is the ONLY maintenance window (the manager holds the activation lifecycle and holds the settlement back — no nested `runMaintenance`); the admission cutoff lives at the LOOP input layer (`send` checks before the durable enqueue), shared by `activation.closing`, direct `followup/steer/inject`, and handle teardown alike — no check-then-dispose; claimed-but-uncommitted batches are restored on a `keepInbox` abort (message ids, order, and exactly-once verified by regression); unloading only the plugin leaves the host alive and parked input intact. See `host-patch/README.md` for the change list, verification-tree rebuild steps, and compatibility notes.

## Minimal capability proposal

### A. Manager-owned maintenance entry (closes gaps A + C; the core)

New public method on the subagent seam (`@deepseek-ai/dsh-subagent`, `SubagentManager`):

```ts
ctx.subagents.runMaintenance(parent: Agent, childId: string, options: {
  signal?: AbortSignal;
  job: (agent: Agent, signal: AbortSignal) => Promise<T>;
}) => Promise<{ result: T }>
```

Semantics — reusing the manager's existing private machinery end to end, no new lifecycle of its own:

1. **Resolve exactly like continuation**: `locks.run(childId)` → `coldResume`-equivalent (observe → lineage + descriptor + preset validation → `materialize`), so authorization, composition rebuild, and pending semantics are identical to a normal continuation. A target whose loaded snapshot holds pending input simply follows the activation lifecycle below (the settlement watcher already refuses to settle while the inbox is non-empty — that *is* the preserve-and-wait behavior).
2. **Resident + announced**: the activation enters `resident` and is announced, so `sendMessage`/`prompt` hit `deliverToChild`'s resident arm (`deliver()`) instead of the writer collision. Normal routes work throughout (gap C closed).
3. **Job window**: run `job` inside the activation's maintenance window (the same shape `watchLocalSettlement` already uses for its close). The settlement watcher must not race a mid-job disposal — the existing `announce`-starts-watcher ordering already gives this if the watcher only starts after the job settles.
4. **Release = ordinary settlement**: after the job settles, the normal settlement path runs — `settlementState` waits while input is pending, `close()` sets `closing` synchronously (the admission cutoff: later deliveries fail cleanly with `ACTIVATION_CLOSING` *before acceptance*), `finishDisposal` releases the writer. Accepted-before-cutoff input is consumed first; the teardown cancel then sees an empty inbox (gap A closed).

Plugin-side change once A exists: the cold branch of `compactPersistedSubagent` becomes a thin call — resolve the engine as today, then `ctx.subagents.runMaintenance(caller, sessionId, { signal, job: (agent, s) => engine.compactNow(agent, s, sourceCommandId) })`. The stranding drain, the release-cutoff drain, and their caveats are deleted.

**Fallback shape, explicitly not preferred:** `AgentHandle.dispose({ keepInbox: true })` alone (gap B only) still leaves normal routes broken (gap C) and leaves the check-then-close window (gap A) — it does not satisfy the contract by itself and is **not** proposed as sufficient.

### B. Lossless unload (closes gap D)

`@deepseek-ai/dsh-agent-loop`: let the teardown cancellation preserve accepted input — e.g. `AgentHandle.dispose(options?: { keepInbox?: boolean })` forwarded to `machine.cancel({kind:"disposed"}, options)`, and/or the manager's drain-stop path keeping inbox for continuable children. Note `keepInbox` alone is not lossless for messages already **claimed** by an aborted turn (claimed-but-unanswered); a complete fix needs either the claimed-batch restore on abort or treating an aborted claim as durable pending. The minimal reviewable slice is the `keepInbox` option; the claimed-message question should be answered in the same review.

### Is stock 0.2.1-rc.2 sufficient without DSH changes?

**No.** Every public route that creates a resident activation submits an ordinary task (`startActivation` requires a prompt); `materialize` is private; `dispose` cannot preserve input. The plugin's current drain/strand machinery is a stock workaround that demonstrably cannot meet contract items 1–3 (see the R2 dual-mode regressions: green in *gap* mode today, red in *contract* mode via `EXPECT_HOST_MAINTENANCE=1 node --test test/cold.integration.test.mjs`).

## Verification plan (real normal routes only)

Against a DSH tree carrying A (+B), all with isolated stores and a local fake model, and the plugin switched to the new entry:

1. **Cutoff interleaving** (reviewer's technique: public `dispose`-wrapper injection): input accepted before the cutoff is processed with a durable `user/message` + answer; input after the cutoff is refused before acceptance; no `outcome:"canceled"` splices; the command never reports success over dropped input.
2. **Normal routes during the whole window**: `subagents.sendMessage` ×N and `subagents.prompt({delivery:"queue"})` at restore / summary-in-flight / release points — accepted and delivered exactly once (or cleanly refused at the published cutoff).
3. **Precheck-race pending** (second legal writer injection): compaction refuses or waits per activation semantics; the injected work is processed exactly once via a *normal* route; same-id continuation answers.
4. **Plugin-only unload** (`ctx.compactorFiber.dispose()`): parked pending survives byte-identical, no canceled splices, same-id continuation processes it afterwards.
5. All existing suites stay green, and the three R2 regressions flip to green in **contract** mode (then the dual mode and this document are retired together).

## Non-goals

No changes to installed artifacts; no implicit host dependencies; no return to live-only compaction; no fake keep-alive tasks or private-registry patches.
