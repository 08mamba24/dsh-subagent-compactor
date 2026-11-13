# Validation record

## Historical branch: 1.3.2 concurrent-resume correction preview

Recorded: **2026-11-10**. Runtime: **stock Harness 0.2.2-rc.1**. This is an unreleased branch preview; the published tag remains `v1.0.1`. Plugin installation and enablement use existing host services. No host maintenance patch or application-source change is required: live children compact directly, and settled continuable children resume through the host's own continuation lifecycle with bounded capacity waiting. The 46/46 record below is the **1.2.0 preview point** (live-only scope); 1.3.0, 1.3.1 and 1.3.2 evidence follows at the end.

The records below distinguish automated runtime tests, an isolated bundled Web UI journey, and historical acceptance of the older candidate. Public evidence contains a summary, sanitized machine evidence, and synthetic screenshots; raw conversations, request bodies, session stores, credentials, and machine profiles are excluded.

### Automated tests: 46/46 (1.2.0 preview point)

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

These counts cover tracked suites only. Two older untracked probes are excluded; a previous 48-test figure is not the regression count for this branch. The old cold integration suite is outside the current implementation and is available in Git history.

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
- That 1.2.0 implementation did not compact settled, unloaded children. Its batches skipped them; 1.3.0 added the resume path described below. A successful `completed` status can still include skips.
- No `v1.2.0` release/tag or approval of an unreviewed public PR is implied by these tests.

## Legacy: unreleased 1.1.0 cold-compaction candidate

The previous repository state described a different implementation: cold restore through a candidate manager-owned maintenance capability, serial batches, a `compact_all_subagents` model tool, a `report <batch-id>` command, and durable plugin-owned batch receipts. Those surfaces were removed in the 1.2.0 branch and remain absent here.

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

- Automated: four tracked suites, **69/69** on the clean pinned npm tree (`npm ci --include=dev`, Node 24). Baseline 46 unchanged; +11 unit resume-path cases, +9 batch cases (resume counting, mixed live+settled, mode pre-skip, abort during resume, nothing-compacted, ownership refusal, wake lock mutual exclusion, resumed-count subset), +2 Host-plane integration cases (resume path; admission-gap cancellation with an unhandled-rejection assertion), +2 preset cases.
- Red-first: both new preset resume cases fail against the previous live-only HEAD `d079037` (no resume: receipts show only skips) and pass on this branch.
- Timing probe (kept outside this repository with the working notes): `subagent/start` fires synchronously after resume and ownership complete and before message delivery; `compactNow` called inside the edge reserves maintenance before the listener returns; the wake stays parked in the inbox until the summary commits (summary → end → next turn ordering verified with a deliberately slow 200 ms summary); `agent/created` is unusable for this (initialization maintenance holds the phase; awaiting idle deadlocks, direct compaction reports busy).
- Preset resume case: two truly settled-and-reclaimed children, one `/subagent-compact all`, two durable summaries with the same `sourceCommandId`, both wake messages answered by normal turns, and a later same-id continuation whose next model request carries the committed checkpoint. Mixed case: the live child is compacted directly with no wake; exactly one maintenance wake exists in the whole run.
- Known limits of this evidence: the model is a loopback fake (no real summary quality), no native Electron-window acceptance yet, and no per-target timeout exists beyond the caller's cancellation signal.

## 1.3.1 capacity backpressure evidence (2026-11-10)

Baseline: `1139607b4747efeb32f024239fd2c201c9e5c938`, version 1.3.0. Node **24.18.0**, clean `npm ci --include=dev`, pinned stock Harness **0.2.2-rc.1**. All new runtime cases use a loopback synthetic model and fresh temporary JSONL storage. No live profiles or real user sessions are loaded.

### Failure and cause

Sixteen children were created sequentially and allowed to settle and be reclaimed naturally. One `/subagent-compact all` with the default limit of eight produced **8 compacted, 8 resume-failed**, with eight durable summaries. The regression assertion expecting all sixteen failed before the implementation changed. Seven initial capacity unit regressions also failed on the baseline.

The batch started all inactive resumes concurrently. The stock manager synchronously reserves capacity before materialization and throws `ACTIVATION_LIMIT_REACHED` when full; it has no implicit queue. The plugin treated that transient refusal as terminal. Compaction's result does not free a slot: the maintenance wake must finish and the activation must settle and dispose. Public `subagent/end` follows actual release. The earlier two-inactive-child acceptance stayed below eight and could not detect this failure.

### Current results

**87/87** tracked tests pass: unit 35, batch 36, integration 3, preset 13. The original 69 tests remain; eighteen new cases cover capacity behavior.

| Scenario | Verified result |
| --- | --- |
| 16 naturally settled children, default 8 slots, exactly one batch | 16 compacted; 16 persisted summaries with the same `sourceCommandId`; exactly one accepted maintenance wake each; observed peak at most 8 |
| All 16 original IDs continued | Every subsequent model request contains its persisted checkpoint and produces output on that same ID |
| Full shared pool, a grandchild outside the caller's snapshot | No target wake before admission; that grandchild's natural settlement frees a slot while the other live occupants keep working |
| Inactive entries ahead of two live entries, second live finishes first | Both live idle windows caught; all four summaries complete; only inactive targets get maintenance wakes |
| Empty summary at capacity 1 | Failure remains visible, delivered wake runs, slot naturally releases, next target completes |
| Real full-pool cancellation and timeout | No summary or late wake for the stopped target, occupant keeps working, fresh invocation can later compact the same ID |
| Unit scheduling and cleanup | Global end hints, failure-to-wait race, no-event probe, cancel/unload, target-lock exclusion, competing batches, non-capacity refusal, post-start refusal, long admitted summary, and foreign start while parked |

Reproduce the full suite with `npm test`. To run the capacity-focused subset:

```sh
node --test --test-timeout=60000 --test-name-pattern='capacity' test/batch.test.mjs test/preset-integration.test.mjs
```

The two-minute default is a finite admission-wait budget, configurable up to ten minutes; it can still time out if existing work holds all slots longer. It is not a summary timeout. These are programmatic stock-runtime tests, not a new native Electron or Web UI acceptance, real-model quality benchmark, release, or daily Desktop deployment.

## 1.3.2 concurrent-resume evidence (2026-11-10)

**92/92** tracked tests pass: unit 35, batch 40, integration 3, preset 14. The five added cases fail against the merged 1.3.1 runtime: an externally restored live child (owned and unauthorized variants), a foreign start followed by an unrelated host refusal or caller cancellation, and an external cold resume queued ahead of maintenance in the real stock child lock.

The stock case fixes capacity at one throughout. A working occupant settles naturally; an external sender then owns the target's child lock while its Session observation is held at a public query boundary. The compactor's retry sees no live Agent and queues behind it. After observation is released, the plugin cancels only its own unaccepted wake, waits for the user's turn to complete, and persists exactly one summary under the initiating command ID. The user's assistant response is durable before that summary, no maintenance message enters its inbox or HTTP requests, and the observed peak remains one. No runtime limits are increased, no working Agent is stopped, and no host implementation is changed.

These are isolated stock-runtime regressions with temporary persistence and loopback synthetic responses. The earlier native-window 16/16 acceptance remains evidence for its recorded 1.3.1 runtime, not a native-window claim for this new runtime or real-model task quality.


## 1.3.3 local rc.1/rc.2 compatibility candidate (2026-11-13)

Baseline: public main `20981ebade6a260bd4a497916b450baeebe5372d` / v1.3.2. Before migration it passed 92/92 on rc.1; unchanged original tests on the installed rc.2 App passed 75/92, with all 17 integration/preset failures at the old activation fixture. Migrating only the fixture contracts, before changing product code, produced a 94-test red run (77 pass / 17 fail): the product's removed listChildren/isOwnedBy calls and grandchild boundary fail independently of the old fixture. An additional authorization red log is retained with the local review evidence.

Final results: **108/108 pass, exit 0** on each of three independent trees: pinned rc.1 npm packages (Node 24.18.0), installed App rc.2 modules (Node 24.21.0), and a clean npm rc.2 tree installed by the exact CI selection script (Node 24.18.0). The candidate runs 108 tests per stock tree: authorization 14, unit 35, batch 40, headless integration 3, preset integration 16. The installed Desktop module route uses App 0.2.2-rc.2, Electron 44.7.0 / Node 24.21.0, ASAR SHA256 `1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d`. The pinned rc.1 npm route uses Node 24.18.0. Tests use isolated homes, temporary JSONL persistence and loopback synthetic model responses.

The 16-target scenario retains the default eight-slot pool, observes peak activity at most eight, commits one summary per original child under the same command ID, accepts exactly one maintenance wake per resumed child, and proves all 16 original IDs receive their checkpoints on follow-up. Existing live-window, failed-summary, cancellation/timeout, external queued-resume and mixed-batch cases run against both contracts. New stock boundaries deny grandchild, self and foreign-parent targets; the intermediate creator can compact the same leaf. The tool follows the same policy. rc.2 denial occurs before sendMessage is called, not merely before compactNow.

The installed-runtime runner now accepts exactly rc.1/rc.2 and verifies every required dsh package agrees. Run `npm ci --include=dev && npm test` for pinned rc.1, or `node scripts/test-installed-runtime.mjs --modules /absolute/node_modules` for either tree. The test-only activation adapter passes each version's real spec; it never adds methods or aliases to runtime services.

This is a local ready-for-review candidate. No push, merge, release, daily plugin link update, Desktop restart or real session operation is included. Earlier rc.1 Electron screenshots/acceptance are historical evidence only; this candidate has no new native-window acceptance claim.
