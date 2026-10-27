# Upstream PR notes — manager-owned maintenance for DSH (draft, NOT submitted)

Prepared locally for review; no PR has been opened against any third-party
repository and no installed Desktop is modified.

## Problem

A finished continuable child cannot be compacted (or otherwise maintained) in
place: every public route that creates a managed activation also submits an
ordinary task, a generic `agents.resume` handle is invisible to the manager
(normal continuation routes fail with `NOT_RESUMABLE` while it holds the
writer), its release unconditionally cancels accepted-but-unprocessed input,
and there is no shared admission cutoff — a check-then-dispose window accepts
input and then drops it. Proofs: real interleavings on 0.2.1-rc.2 with an
isolated store and a local fake model (see docs/VALIDATION.md rounds 1–5).

## Candidate API

```ts
// @deepseek-ai/dsh-subagent (SubagentRuntime, delegated to SubagentManager)
ctx.subagents.runMaintenance<T>(
  parent: Agent, childId: SessionId,
  options: { signal?: AbortSignal, job: (agent: Agent, signal: AbortSignal) => Promise<T> },
): Promise<T>
```

Lifecycle: resident restore exactly like a continuation (same authorization
and composition reconstruction via `resumeActivation`); the settlement
watcher is held back for the job's duration (the job itself enters the loop's
maintenance phase — exactly one window, no nesting); afterwards the ordinary
settlement takes over. Supporting changes: `Agent.closeInput()` checked
synchronously at the single enqueue chokepoint (`send`), set in the same
synchronous section as `activation.closing` (one admission boundary for
manager delivery and every public input); `AgentHandle.dispose({ keepInbox })`
and claimed-but-uncommitted batch restore on abort; the manager's drain-stop
releases with `keepInbox`.

## Regression evidence (isolated patched tree, fake LLM, temp storage)

- 59/59 tests: 39 unit, 1 live-window integration, 19 cold/contract integration.
- Acceptance contract: accepted input never lost (including the pre-step
  claim window and release-cutoff interleavings); normal routes (`sendMessage`,
  addressed `prompt({delivery:"queue"})`) deliver throughout, including while
  pending input keeps the activation resident; plugin-only unload preserves
  parked input and the same message id continues exactly once; cutoff rejects
  before the durable enqueue; claimed batches restore by id and order.
- Stock-tree diagnostics (`GAP_DIAG=1`) assert the capability is absent on
  0.2.1-rc.2 and the plugin refuses cold compaction explicitly.
- Type check: full affected-file baseline comparison — zero new diagnostics
  (targeted tsc program; complete monorepo build not run).

## Compatibility risk

- Additive API; no existing path changes except (a) a manager `close()` now
  also closes the agent's input surface at the same instant — post-close
  public input is rejected before acceptance instead of being accepted and
  later cancelled (this is the contract fix; senders racing a close get a
  clear error instead of silent loss), and (b) the manager's drain-stop
  preserves parked input instead of cancelling it.
- Public types added to `@deepseek-ai/dsh-agent` (`Agent.closeInput`,
  `AgentHandle.dispose(options)`); no runtime change in that package.
- Risk concentration: the loop input cutoff and claimed-batch restore touch
  the turn machinery; both carry red-first regressions from the reviewer's
  own proofs.
