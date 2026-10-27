# Host maintenance capability — minimal candidate patch

These diffs are the **isolated candidate host change** behind review round 3's
direction ("prepare a minimal host patch + thin plugin call"). They are NOT a
dependency of the published plugin: on a stock runtime the plugin detects the
missing capability and refuses cold compaction explicitly
(`host-capability-missing`), and `GAP_DIAG=1` diagnoses that state.

- `0001-harness-source-…diff` — TypeScript source, produced in a clean
  worktree of `deepseek-ai/deepseek-harness` at tag `dsh-v0.2.1-rc.2`
  (commit `687f282e8625c6b8d11ff58211a90524be2e4317`). This is the reviewable
  artifact.
- `0002-…` / `0003-…equivalent.diff` — the same changes applied to the two
  compiled `lib/index.js` files of the installed 0.2.1-rc.2 tree, used to
  build the isolated verification tree (`host-patched/node_modules`: every
  package symlinked to the stock tree except `@deepseek-ai/dsh-agent-loop`
  and `@deepseek-ai/dsh-subagent`, which carry the patch). One-to-one with
  the source diff; no other package is touched.

Rebuild the verification tree:

```sh
mkdir -p host-patched/node_modules/@deepseek-ai
for entry in /path/to/stock/node_modules/@deepseek-ai/*; do
  name=$(basename "$entry")
  case "$name" in
    dsh-subagent|dsh-agent-loop) cp -R "$entry" "host-patched/node_modules/@deepseek-ai/$name" ;;
    *) ln -s "$entry" "host-patched/node_modules/@deepseek-ai/$name" ;;
  esac
done
# then apply 0002 and 0003 to the two copies (or copy from a patched tree)
ln -s "$PWD/host-patched/node_modules" node_modules
node --test test/unit.test.mjs test/integration.test.mjs test/cold.integration.test.mjs
# stock diagnosis:
ln -s /path/to/stock/node_modules node_modules
GAP_DIAG=1 node --test --test-name-pattern "cold R2" test/cold.integration.test.mjs
```

## What the patch changes

1. `packages/core/agent-loop` — `Agent.closeInput()` + a synchronous
   admission check at the single enqueue chokepoint (`send`, i.e. every
   public input: followup/steer/inject, hence every manager delivery);
   `cancel(cause, {keepInbox})` records the abort semantics and an aborted
   turn restores its claimed-but-uncommitted batch to the inbox (tracked via
   this-turn user/message commits); handle teardown closes input first and
   `dispose({keepInbox})` forwards to the teardown cancel; the subagent
   manager's drain-stop now cancels with `keepInbox: true`.
2. `packages/subagent/subagent` — `SubagentManager.resumeActivation`
   (coldResume's observation/authorization/descriptor/preset/materialize
   without any delivery; `coldResume` now delegates to it, behavior
   unchanged) and `SubagentManager.runMaintenance(parent, childId,
   {signal, job})` exposed as `ctx.subagents.runMaintenance`: resident
   restore under the child lock, the job runs while the settlement watcher
   is held back (the engine's own `compactNow` is the only maintenance
   window — no nesting), then `announce` hands the activation to the
   ordinary settlement lifecycle (pending input keeps it resident and
   reachable by normal routes; the close sets `activation.closing` AND the
   agent input cutoff in one synchronous section; `finishDisposal` releases
   the writer). `SubagentRuntime.runMaintenance` delegates with the same
   exact-live-parent check as `startActivation`.

## Scope of verification (honest boundaries)

- Source baseline: `deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317` (clean worktree; `0001` is its full diff).
- Affected host packages: **three** — `@deepseek-ai/dsh-agent-loop` (cutoff, claimed-batch restore, keepInbox teardown), `@deepseek-ai/dsh-subagent` (`resumeActivation`, `runMaintenance`, lossless stop), and `@deepseek-ai/dsh-agent` (public type declarations only: `Agent.closeInput`, `AgentHandle.dispose(options)`; no runtime change).
- Type checking: targeted tsc program over all six affected files compared against the clean baseline (`/tmp/dsh-r4-full-type-review.cjs` method): baseline 6 = patched 6, zero NEW diagnostics (the six are external-dependency diagnostics shared with the clean tree). A **complete monorepo build has not been run**; that remains open for the upstream route.
- Runtime validation is the isolated patched tree only (fake LLM, temp storage). Real-Desktop cold-compaction acceptance has not been run; the 1.0.1 Desktop acceptance covered the live-window behavior only.

## Upstream PR draft

See [UPSTREAM_PR_NOTES.md](UPSTREAM_PR_NOTES.md) — problem, candidate API, regression evidence, compatibility risk. Not submitted anywhere.

## Compatibility

Stock runtime: the plugin reports `host-capability-missing` for cold
compaction and live-window compaction is unaffected (the pre-existing
suites pass unchanged on the stock tree). Patched runtime: **59/59**
tests pass across the full suites, including the acceptance-contract
regressions; the type-only follow-up round (`d7dc960`) additionally ran a
targeted 7/7 (R4 regressions, claim evidence, live-window integration)
with no behavior change. The patch adds
capability; it does not change existing paths except (a) a `close()` now
also closes the agent's input surface at the same instant (post-close
public input is rejected instead of being accepted-then-cancelled), and
(b) the manager's drain-stop preserves parked input instead of cancelling
it — both are the contract review round 3 required.
