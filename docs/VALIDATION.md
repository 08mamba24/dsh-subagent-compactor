# Validation record

## Current branch: 1.3.0 settle-and-resume preview

Recorded: **2026-11-10**. Runtime: **stock Harness 0.2.2-rc.1**. This is an unreleased branch preview; the published tag remains `v1.0.1`. Plugin installation and enablement use existing host services. No host maintenance patch or application-source change is required for this live-only scope.

The records below distinguish automated runtime tests, an isolated bundled Web UI journey, and historical acceptance of the older candidate. Public evidence contains a summary, sanitized machine evidence, and synthetic screenshots; raw conversations, request bodies, session stores, credentials, and machine profiles are excluded.

### Automated tests: 46/46

Both verification routes passed all four tracked suites:

| Suite | Tests | Main coverage |
| --- | ---: | --- |
| `test/unit.test.mjs` | 25 | Error mapping, cancellation, authorization, engine lookup, residency recheck, command parsing, and unload |
| `test/batch.test.mjs` | 15 | Concurrent fan-out, result ordering, skipped settled children, contention, item failures, and cancellation |
| `test/integration.test.mjs` | 1 | Real runtime lifecycle, compaction persistence, surface shrink, continuation, and foreign-parent rejection |
| `test/preset-integration.test.mjs` | 5 | Real preset engine lookup, isolated composition, and child model routing |
| **Total** | **46** | **All passed** |

1. **Installed-runtime route:** a scratch copy of the plugin and four tracked suites used the official `0.2.2-rc.1` module tree with isolated test homes and storage.
2. **Clean npm route:** this public branch used Node `24.18.0`, a fresh dependency install through `npm ci --include=dev`, and `npm test`. All 46 passed with exit code 0, without a host patch, `--force`, or `--legacy-peer-deps`.

These counts cover tracked suites only. Two older untracked probes are excluded; a previous 48-test figure is not the regression count for this branch. The old cold integration suite is outside the 1.2.0 implementation and is available in Git history.

Reproduce with Node 24.9.0 or newer:

```sh
npm ci --include=dev
npm test
```

The explicit `--include=dev` also installs test runtimes when the shell inherits `NODE_ENV=production`. Tests use temporary storage and a local synthetic Messages endpoint, with no external model calls.

### Bundled Web UI: two live children compacted and continued

The isolated acceptance run loaded the real bundled Web UI and runtime from the installed application. A fresh browser context, scratch workspace, test homes, and loopback synthetic model service kept this run separate from daily sessions and credentials. Commands went through the actual input box rather than a direct call to the compaction function.

| Step | Observed result |
| --- | --- |
| Start two direct children in the standard preset | Both stayed live behind a controlled request barrier |
| Enter bare `/subagent-compact` | Both children were listed as `live` |
| Enter `/subagent-compact all` | Two `compacted`, zero skipped, zero failed; successful command result |
| Read child persistence from disk | Both committed summaries were present and linked to the batch command |
| Continue both original session IDs | Both produced subsequent assistant output |
| Inspect subsequent model requests | Both contained the committed checkpoint |
| Check browser errors | Zero page errors |

The tested plugin's `index.js` SHA-256 was:

```text
efe60e9060d91e74783ca015719bbf555894570fe4544f863eeede86906dc8e0
```

Each successful item replaced three old history items. Its token figure estimates the replaced span; it is not a measurement of net savings. See the [public acceptance summary](acceptance/2026-11-10-live-only/acceptance.md) and its sanitized evidence.

### What this proves, and what remains outside it

- The stock runtime can execute the live batch command, persist each child's summary, and reuse each checkpoint on same-ID continuation. The plugin does not need the old candidate host patch for these operations.
- The Web UI proof covers the installed application's Web pipeline. It does not establish that a user's already-running daily Electron process has loaded the new plugin, or that the Electron shell was exercised.
- The synthetic model makes the mechanism deterministic. It does not evaluate real-model summary quality, fact retention, or provider rate limits under a large batch.
- Batch command output has no independent receipt store. Cancellation can discard the host command result; the test's durable child summaries do not imply durable per-item batch receipts.
- The implementation does not compact settled, unloaded children. Batch results skip those targets; a successful `completed` status can include skips.
- No `v1.2.0` release/tag or approval of an unreviewed public PR is implied by these tests.

## Legacy: unreleased 1.1.0 cold-compaction candidate

The previous repository state described a different implementation: cold restore through a candidate manager-owned maintenance capability, serial batches, a `compact_all_subagents` model tool, a `report <batch-id>` command, and durable plugin-owned batch receipts. Those surfaces are removed from the current 1.2.0 branch.

Its independent review and Desktop acceptance used Harness `0.2.1-rc.2` with an isolated patched Desktop copy. That historical result does not establish stock cold-compaction support and is not the installation procedure for 1.2.0. No 1.1.0 tag or release was created.

Historical material remains available:

- [Patched Desktop batch acceptance](acceptance/2026-10-27-batch/acceptance.md) and [sanitized machine evidence](acceptance/2026-10-27-batch/evidence.json).
- [Host patch documentation](../host-patch/README.md) and [Chinese preparation guide](../host-patch/README.zh-CN.md).
- [Cold compaction plan](COLD_COMPACTION_PLAN.md) and [host maintenance requirements](HOST_MAINTENANCE_REQUIREMENTS.md).
- Git history for earlier review rounds, cold regression suites, and receipt-store implementation.

## Published 1.0.1: historical record

The released `v1.0.1` implementation provided listing and single live-child compaction. Its earlier automated run passed **26 tests** (25 unit and one real-runtime integration). Desktop acceptance covered listing, the model tool, the parameterized command, and same-ID continuation with real-model fact retention on the then-tested runtime.

That record belongs to the released 1.0.1 code and runtime. The 1.2.0 compatibility and batch claims are supported by the separate current records above.

## 1.3.0 settle-and-resume evidence (2026-11-10)

- Automated: four tracked suites, **67/67** on the clean pinned npm tree (`npm ci --include=dev`, Node 24). Baseline 46 unchanged; +11 unit resume-path cases, +8 batch cases (resume counting, mixed live+settled, mode pre-skip, abort during resume, nothing-compacted, ownership refusal, wake lock mutual exclusion), +1 Host-plane integration resume case, +2 preset cases.
- Red-first: both new preset resume cases fail against the previous live-only HEAD `d079037` (no resume: receipts show only skips) and pass on this branch.
- Timing probe (kept outside this repository with the working notes): `subagent/start` fires synchronously after resume and ownership complete and before message delivery; `compactNow` called inside the edge reserves maintenance before the listener returns; the wake stays parked in the inbox until the summary commits (summary → end → next turn ordering verified with a deliberately slow 200 ms summary); `agent/created` is unusable for this (initialization maintenance holds the phase; awaiting idle deadlocks, direct compaction reports busy).
- Preset resume case: two truly settled-and-reclaimed children, one `/subagent-compact all`, two durable summaries with the same `sourceCommandId`, both wake messages answered by normal turns, and a later same-id continuation whose next model request carries the committed checkpoint. Mixed case: the live child is compacted directly with no wake; exactly one maintenance wake exists in the whole run.
- Known limits of this evidence: the model is a loopback fake (no real summary quality), no native Electron-window acceptance yet, and no per-target timeout exists beyond the caller's cancellation signal.
