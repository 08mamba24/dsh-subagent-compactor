# Host assembly patrol attribution acceptance

Date: 2026-11-24 (Asia/Shanghai). Author: 谱谱 (cat-zcode) / glm-5.4.
Tested commit: `01ec7a8c776582e6484c0b6d51f8c52ff2830a9c`, directly on the reviewed candidate `0cbf5b2e6a030c88f2890006233f0663e72ad53f` (base `0917cb3c6adece6fa1bad9b849fbc9de7089a323`).
Checkout: `/Users/yuhan/codespace/dsh-subagent-compactor-alpha2`, branch `fix/alpha2-compat`, draft PR #13.

## Agreement and result

砚砚62 reported that the remaining blocker on PR #13 was the alpha.1 cell of the hourly watch: the published host fails before this plugin loads, and the fixture then kept the run alive until the deadline. They asked for the patrol fix, resource cleanup and result attribution, with Pro reviewing the new commits independently and 砚砚62 taking back acceptance. Installation and restart wait for a separate authorization.

The fix is implemented and validated. An alpha.1 candidate is now reported **`NOT_VERIFIED`** in 50 s with the failing host row named, instead of **`INFRA_ERROR`** at the deadline. rc.1–rc.5 and alpha.2 are unchanged at **125/125**, watcher contracts pass **41/41**, and four mutation checks each turn one new regression red. Nothing was merged, tagged, released, installed or restarted.

## What the Actions run showed

[Run 45333552103](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/45333552103) (`Upstream compatibility watch`, attempt 1, head `0cbf5b2`) tested alpha.2, alpha.1 and rc.5. Its public job and step metadata is kept in [actions-run-45333552103-jobs-summary.json](actions-run-45333552103-jobs-summary.json):

| Job | Conclusion | Duration | Runner step | Result saved |
| --- | --- | --- | --- | --- |
| `Harness dsh-v0.2.3-alpha.1` | success | 426 s | 375 s, success | no (steps skipped) |
| `Harness dsh-v0.2.3-alpha.2` | success | 80 s | 36 s, success | yes |
| `Harness dsh-v0.2.2-rc.5` | success | 66 s | 27 s, success | yes |
| `Classify the watch result` | **failure** | 4 s | `Preserve the three-state verdict` failed | |

The alpha.1 job itself reports success because the CLI exits 0 once a report is saved; only the final gate is red. The job logs need authentication and were not read, so the classification of that run is not quoted here. The gate fails only for `INCOMPATIBLE` or `INFRA_ERROR`, and the same tree and lock reproduce `INFRA_ERROR` locally, below.

## Root cause

- alpha.1's own packages read the `Context.root` static, for example `@deepseek-ai/dsh-typert-protocol/lib/index.js:361` (`ctx[Context.root]`), which is reached while `dsh-llm` mounts. The Cordis 4.1.0 resolved by alpha.1's own lock defines no such static, so the lookup becomes `ctx[undefined]` and Cordis throws `cannot get property "undefined" without inject`. The tree holds a single copy of Cordis. rc.5 resolves the same Cordis 4.1.0 and assembles; alpha.2 resolves 4.2.0-alpha.1.
- The fixture started its loopback model listener before composition and entered its `try` only after composition had succeeded. On alpha.1 three integration tests and ten capacity tests each left a listener open. `node --test` stayed alive until the watcher killed it, and the spec reporter, which prints failure details only at the end, showed nothing but `✖` rows.

## Changes

- Fixture (`test/runtime-fixture.mjs`): `trackFixtureListener` records every fixture HTTP listener; the root `after` hook `releaseLeakedFixtureListeners` closes any that outlived its test and fails the file with `N fixture HTTP listener(s) outlived their test`. `reportHostAssemblyFailure(stage, error)` prints the `DSH_HOST_ASSEMBLY_FAILED` line. `inertHost` and `INERT_MODULE` let a phase check compose a host that touches no service.
- Compositions (`test/integration.test.mjs`, `test/preset-integration.test.mjs`): each composition names the host step in progress, announces a failing host row, and clears the stage before the plugin under test is imported. The three integration tests start their fake model inside the `try`. `capacityRuntime` registers its cleanup before it boots. The optional auth row can be supplied through `hostModules`.
- Classifier and CLI: `classifyRunnerResult` maps the marker to `NOT_VERIFIED` with the reason `upstream host failed to assemble before the plugin loaded`, after the `AssertionError` branch. `firstFailure` recognises the marker line. Nothing changed outside `test/` and these two functions: runner script, `index.js`, `package.json`, workflows and the candidate recipe are as in the candidate.
- Tests: five stock tests (a leak self-check and two phase checks per composition file) and two watcher contracts. Stock suites go from 120 to 125, watcher contracts from 39 to 41.

## Red to green

The red artifacts were produced while the change was being written, in a scratch copy of this checkout. The green side is the formal run recorded in this directory.

1. **Baseline, candidate `0cbf5b2` unmodified, alpha.1, real watcher CLI** (`prepare`, then `run --timeout-ms 240000`): `INFRA_ERROR`, `runtime regression timed out`, `testExitCode` null, no test summary, first failure a bare `✖` row. The run step took 278 s here with a 240 s runner deadline; the CLI's default deadline, which Actions uses, is six minutes. [alpha1-baseline-infra-error-report.json](alpha1-baseline-infra-error-report.json), [alpha1-baseline-infra-error-run.log](alpha1-baseline-infra-error-run.log).
2. **Watcher contracts against the unmodified classifier and CLI**: 39/41. Both new contracts fail. [watcher-red.log](watcher-red.log).
3. **First version of the phase checks, on rc.1**: 121/123. That version combined both halves into one test per file and failed with `Missing expected rejection`, so it asserted on the wrong thing on a runtime that does assemble. [fixture-red-rc1.log](fixture-red-rc1.log).
4. **Leak self-check alone on alpha.1, before the call sites were fixed**: 125 tests, 100 pass, 25 fail, and the run ends by itself. 21 are the host failures, 2 the combined phase checks of step 3, and 2 the new root hooks, which name the leaks: `3 fixture HTTP listener(s) outlived their test` and `10 fixture HTTP listener(s) outlived their test`. [alpha1-selfcheck-red.log](alpha1-selfcheck-red.log).
5. **Green**: alpha.1 `NOT_VERIFIED` in 49.9 s with no `AssertionError`, `outlived` or `timed out` line; rc.1 125/125; watcher 41/41.

## Executed validation

Managed command: `/usr/bin/python3 -I docs/acceptance/2026-11-24-alpha1-host-assembly/validate.py`.
Driver output: [validate-driver.out](validate-driver.out), last line `validate exit=0`.
Recorded run: `2026-11-24T07:08:41.170752+00:00` to `2026-11-24T07:18:46.608335+00:00`.
Node: Homebrew `24.22.3`, binary SHA256 `2c711dba4c61d710efa4e806dd87c6bf1532aa02afb95515c1c60efa0275ffec`.

| Scope | Result | Evidence |
| --- | --- | --- |
| Watcher contracts | 41/41 | [watcher.log](watcher.log) |
| Stock 0.2.2-rc.1 | 125/125 | [rc1.log](rc1.log) |
| Stock 0.2.2-rc.2 | 125/125 | [rc2.log](rc2.log) |
| Stock 0.2.2-rc.3 | 125/125 | [rc3.log](rc3.log) |
| Stock 0.2.2-rc.4 | 125/125 | [rc4.log](rc4.log) |
| Stock 0.2.2-rc.5 | 125/125 | [rc5.log](rc5.log) |
| Stock 0.2.3-alpha.2, freshly installed from the committed host lock | 125/125 | [alpha2.log](alpha2.log), [install-alpha2.log](install-alpha2.log) |
| Watcher `prepare`/`run`, 0.2.3-alpha.2 (`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`) | `COMPATIBLE` 125/125, 47.6 s | [alpha2-report.json](alpha2-report.json), [alpha2-prepare.log](alpha2-prepare.log), [alpha2-run.log](alpha2-run.log) |
| Watcher `prepare`/`run`, 0.2.3-alpha.1 (`d98f5d68519215da48f3002da2cb9c9d2068d81d`) | `NOT_VERIFIED`, 125 tests / 102 pass / 21 fail / 2 skipped, 49.9 s | [alpha1-report.json](alpha1-report.json), [alpha1-prepare.log](alpha1-prepare.log), [alpha1-run.log](alpha1-run.log) |
| Watcher `prepare`/`run`, 0.2.2-rc.5 (`9c2670d3bce5275e0d1610272958121af87787bb`) | `COMPATIBLE` 125/125, 48.1 s | [rc5-report.json](rc5-report.json), [rc5-prepare.log](rc5-prepare.log), [rc5-run.log](rc5-run.log) |
| Source package inspection | exit 0 | [pack.log](pack.log) |

All green suites have zero failed, cancelled, skipped or TODO cases. The alpha.1 cell was asserted in detail: the reason, exit code 1, the marker as first failure, Cordis 4.1.0, 21 marker lines for 21 failures, no assertion, leak or timeout text, and under 120 s. All three cells share runner digest `59985b26f3c22e0458cb2f1002ba2c8e6c135333f403d195fe52a5c3d2cc2ece`.

[validation.json](validation.json) records exact argv, working directories, report and log digests and 19 tested file digests; those files were unchanged across the run and rechecked at its end. rc.2–rc.4 were installed into owned scratch directories with the pinned recipe of stable CI ([install-rc2.log](install-rc2.log), [install-rc3.log](install-rc3.log), [install-rc4.log](install-rc4.log)); rc.1 and rc.5 borrowed the documented existing stock trees read-only. HOME, TMPDIR, npm cache and every session store were isolated. The driver's scratch directory held no fixture leftover at the end and was removed. `git diff --check` is clean for the authored files; the raw logs keep, verbatim, the indented blank lines that the `node --test` reporter prints.

## Mutation checks

Each mutant is a scratch copy of the tested commit with one change, run through the same runner or the watcher contracts. Every one exits non-zero within 25 s.

| Mutant | Result | Evidence |
| --- | --- | --- |
| Stage never cleared in both composition files (rc.1) | 123/125: both "is not announced" phase checks fail | [mutant-stage-never-cleared-rc1.log](mutant-stage-never-cleared-rc1.log) |
| Capacity cleanup registered after boot (alpha.1) | 126 tests, 22 fail: the hook names 10 leaked listeners | [mutant-capacity-cleanup-after-boot-alpha1.log](mutant-capacity-cleanup-after-boot-alpha1.log) |
| Composition moved out of the `try` (alpha.1) | 126 tests, 22 fail: the hook names 1 leaked listener | [mutant-callsite-boots-outside-try-alpha1.log](mutant-callsite-boots-outside-try-alpha1.log) |
| Classifier ignores the marker | watcher 39/41: both host-assembly contracts fail | [mutant-classifier-ignores-marker-watcher.log](mutant-classifier-ignores-marker-watcher.log) |

A failing root hook is counted as one more test. That is why the two alpha.1 mutants show 126 tests and 22 failures: the 21 host failures and the hook; the two phase checks skip.

## Decisions for the reviewer

1. alpha.1 moves from `INFRA_ERROR` (red gate) to `NOT_VERIFIED` (warning plus an anomaly issue). This is intended: the gate stops being red while the alpha.1 issue stays open as a request for analysis. `NOT_VERIFIED` is cached, so later hourly runs reuse it until the plugin SHA, dependency lock or runner digest changes.
2. An `AssertionError` anywhere in the output still wins over the marker. Unit, batch and authorization tests exercise the plugin without composing a host, so a real product failure cannot hide behind a host fault.
3. The leak message is itself an `AssertionError`. If a fixture ever leaks again, the watch reports `INCOMPATIBLE` rather than a timeout.
4. The two "is not announced" checks skip on a host that cannot assemble. Their precondition boots run under a mocked `console.error`, which is why the alpha.1 log has 21 marker lines for 21 failures, not 23.
5. Unchanged and older than this fix: a plugin mount failure that is not an `AssertionError` on a healthy host is `NOT_VERIFIED` (`test failure origin could not be attributed`), not `INCOMPATIBLE`. It is recorded here as an observation, not as something this change introduces or settles.
6. The runtime that alpha.1 would have provided is not exercised anywhere: its host never comes up, so alpha.1 stays unsupported and no fixture or product code is adapted to it.

## Quality gate and review boundary

Risk: behavior = attribution of a host that cannot be assembled, and fixture cleanup; data = isolated JSONL only, no migration; security = no new permissions or credentials; contract = the stock suite runs unchanged on every supported host; irreversible = none. The upstream fault is not fixed here and cannot be: alpha.1's published packages need a Cordis static that its own lock does not provide.

Fallback analysis: none added. The marker is one line printed at the throwing call site; the leak check is one root hook in each file that creates listeners.

Not exercised: a GitHub job for this HEAD (the push starts pull request runs whose results are not part of this record), Desktop GUI, installed profiles, real models, and the alpha.1 runtime beyond the fact that it does not assemble. Local deadlines differ from Actions: `prepare` 240 s and `run` 180 s here, against the CLI's default six minutes there. A local run is therefore never longer than the Actions one.

The requested independent reviewer is Pro; acceptance returns to 砚砚62. Approval must bind the pushed HEAD. Merge, release, installation and restart remain separate actions without authorization.
