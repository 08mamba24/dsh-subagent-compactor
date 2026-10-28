# Host maintenance capability — minimal candidate patch

[中文：补丁原理、Desktop 副本制作方式与安装边界](README.zh-CN.md)

**Installing the plugin does not apply these host patches.** Candidate source and CI are merged into this repository's `main`; that does not add the maintenance API to an installed stock Desktop. On macOS (Apple silicon) this directory now ships **portable make/launch/check scripts** for an independent patched Desktop copy (gated to Desktop 0.12.1 / Harness 0.2.1-rc.2); there is no released patched Desktop distribution.

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

## Reproduce automated verification

Use the committed lockfile and the same commands as CI:

```sh
npm ci
npm run test:stock
npm run test:gap-diag
```

For the patched lane, follow the exact copy, absolute-symlink, and patch steps in [.github/workflows/ci.yml](../.github/workflows/ci.yml), then run `npm run test:patched`. That workflow keeps two real package copies and links the remaining packages to a separate stock tree. It does not modify an installed Desktop. Both lanes passed on real Ubuntu GitHub runners: stock 46 tests plus 3 gap diagnostics, patched 83 tests.

## Make a patched Desktop copy (executable commands)

Declared and gate-checked baseline: **macOS arm64 + official Desktop 0.12.1 / Harness 0.2.1-rc.2** (`app.asar` SHA256 `366bef41…fefaaa`). Anything else is refused explicitly — no fuzzy adaptation. After `npm ci` in the repository root:

```sh
# Make (verifies source version/bundle id/hash first; builds inside a stage,
# lands at the target with one final rename; a failure cleans only its stage)
node host-patch/make-desktop-copy.mjs \
  --source "/Applications/DSH Desktop.app" \
  --target "<your dir>/DSH Desktop Compactor.app"

# Launch (or double-click the copy — profile/ports are baked in, so both are safe)
node host-patch/launch-desktop-copy.mjs --app "<your dir>/DSH Desktop Compactor.app"

# Check anytime (copy integrity + signature + original still the baseline)
node host-patch/check-desktop-copy.mjs --app "<your dir>/DSH Desktop Compactor.app"
```

`make-desktop-copy.mjs` clones the source app into an isolated stage, extracts `app.asar`, applies 0002/0003 to the **stock** extracted `dsh-agent-loop`/`dsh-subagent` libs (any fuzz/offset fails the build), switches the copy to the development channel with a target-derived profile/port pair baked into the app (a bare double-click can never land on the everyday `dsh-desktop` profile), repacks the archive preserving the unpacked layout, refreshes Electron ASAR integrity, sets a unique bundle id, ad-hoc signs and verifies only the copy, and re-confirms the source archive hash. Every identity and hash lands in `<copy>.app.manifest.json`. Existing targets, nested/dangerous paths, and leftover stages are refused.

After launching, install this repository's plugin through the copy's official **Plugins → Add plugin** UI and use `/subagent-compact` / `--all` in a parent session. Rollback = quit the copy and delete it plus its sidecar manifest; sessions created in the copy's own profile are preserved by default. The full user path (including rollback details) is in the [top-level README](../README.md).

Safety boundaries: the source app is never written or overwritten; the everyday profile is never touched; the debug port exists only with an explicit `--debug-port`.

The first real-machine acceptance (independent copy + official-UI plugin install + real-model cold batch, continuation, and restart receipts) is recorded in the [acceptance report](../docs/acceptance/2026-10-27-batch/acceptance.md) — it used the equivalent local predecessor script; the scripts here are its portable form. The make/launch/check flow and its refusal paths are covered by [regression tests](../test/desktop-copy.test.mjs) (wrong version/hash/bundle id, dangerous or existing targets, failure cleanup, repeat runs, launch isolation).

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
- Runtime verification includes the isolated fake-model suites and real-model acceptance on an independently patched Desktop copy. The [batch acceptance report](../docs/acceptance/2026-10-27-batch/acceptance.md) proves two settled children compacted through both entries, continued under the same IDs with remembered facts, and retained their receipts through a full app restart. This does not establish stock Desktop support.

## Upstream PR draft

See [UPSTREAM_PR_NOTES.md](UPSTREAM_PR_NOTES.md) — problem, candidate API, regression evidence, compatibility risk. Not submitted anywhere.

## Compatibility

Stock runtime: the plugin reports `host-capability-missing` for cold
compaction and live-window compaction is unaffected (the pre-existing
suites pass unchanged on the stock tree). Current CI passes **46 stock tests + 3 gap diagnostics** and **83 patched tests**; the [merged-main runner result](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/40554288771) records that verification. Earlier host-review evidence was 59/59, followed by targeted 7/7 for the type-only `d7dc960` changes; those are historical subsets, not the current suite count. The patch adds
capability; it does not change existing paths except (a) a `close()` now
also closes the agent's input surface at the same instant (post-close
public input is rejected instead of being accepted-then-cancelled), and
(b) the manager's drain-stop preserves parked input instead of cancelling
it — both are the contract review round 3 required.
