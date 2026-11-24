# Host assembly patrol attribution acceptance

Date: 2026-11-24 (Asia/Shanghai). Author: 谱谱 (cat-zcode) / glm-5.4.
Tested commit: `15ba0015c19dc5475fa4a02ceb0dbb9bcf0cc8c4`, on the record `ab8c63f3eb65b0cd4c60e36460d7ec8d1314ea8d` of the first fix `01ec7a8c776582e6484c0b6d51f8c52ff2830a9c`, on the reviewed candidate `0cbf5b2e6a030c88f2890006233f0663e72ad53f` (base `0917cb3c6adece6fa1bad9b849fbc9de7089a323`).
Checkout: `/Users/yuhan/codespace/dsh-subagent-compactor-alpha2`, branch `fix/alpha2-compat`, draft PR #13.

## Agreement and result

砚砚62 asked for the patrol fix, resource cleanup and result attribution for the alpha.1 cell of the hourly watch, with Pro reviewing each new commit independently and 砚砚62 taking back acceptance. The first fix is `01ec7a8`. Pro's independent review of it requested changes. R1, blocking: a fixture listener leak was reported with an `AssertionError`, which the watcher read as this plugin's, and so was an assertion raised by a host row. R2: a plugin-phase check skipped after any error of its precondition. R3: a cleanup that threw replaced the original host failure. This commit addresses R1–R3 and nothing else. Installation and restart wait for a separate authorization.

The fix is implemented and validated. Through the real watcher CLI, an alpha.1 candidate is reported **`NOT_VERIFIED`** in 41.2 s with the failing host row named, and all 21 failures are thrown as the fixture's `HostAssemblyError`. rc.1–rc.5 and alpha.2 pass **131/131**, watcher contracts pass **45/45**. The same watcher contracts fail five times against the classifier and CLI of `ab8c63f`, and thirteen mutation checks each turn exactly the regressions of their change red. Nothing was pushed, merged, tagged, released, installed or restarted.

## What the Actions run showed

[Run 45333552103](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/45333552103) (`Upstream compatibility watch`, attempt 1, head `0cbf5b2`) tested alpha.2, alpha.1 and rc.5. Its public job and step metadata is kept in [actions-run-45333552103-jobs-summary.json](actions-run-45333552103-jobs-summary.json):

| Job | Conclusion | Duration | Runner step | Result saved |
| --- | --- | --- | --- | --- |
| `Harness dsh-v0.2.3-alpha.1` | success | 426 s | 375 s, success | no (steps skipped) |
| `Harness dsh-v0.2.3-alpha.2` | success | 80 s | 36 s, success | yes |
| `Harness dsh-v0.2.2-rc.5` | success | 66 s | 27 s, success | yes |
| `Classify the watch result` | **failure** | 4 s | `Preserve the three-state verdict` failed | |

The alpha.1 job itself reports success because the CLI exits 0 once a report is saved; only the final gate is red. The job logs need authentication and were not read, so the classification of that run is not quoted here. The gate fails only for `INCOMPATIBLE` or `INFRA_ERROR`, and the same tree and lock reproduce `INFRA_ERROR` locally, below. This run is about the candidate `0cbf5b2`; no Actions run exists for either fix commit.

## Root cause

- alpha.1's own packages read the `Context.root` static, for example `@deepseek-ai/dsh-typert-protocol/lib/index.js:361` (`ctx[Context.root]`), which is reached while `dsh-llm` mounts. The Cordis 4.1.0 resolved by alpha.1's own lock defines no such static, so the lookup becomes `ctx[undefined]` and Cordis throws `cannot get property "undefined" without inject`. The tree holds a single copy of Cordis. rc.5 resolves the same Cordis 4.1.0 and assembles; alpha.2 resolves 4.2.0-alpha.1.
- In the candidate the fixture started its loopback model listener before composition and entered its `try` only after composition had succeeded. On alpha.1 three integration tests and ten capacity tests each left a listener open. `node --test` stayed alive until the watcher killed it, and the spec reporter, which prints failure details only at the end, showed nothing but `✖` rows.
- In the first fix the leak hook reported that leak with `assert.deepEqual`, so the reporter printed an `AssertionError`, and the classifier read any `AssertionError` as this plugin's before it looked at the host marker. A defect of the fixture would have been filed as an incompatibility of the upstream version.

## Changes for R1–R3

- R1, fixture (`test/runtime-fixture.mjs`): the leak hook prints `DSH_FIXTURE_LISTENER_LEAK N fixture HTTP listener(s) outlived their test` and throws `FixtureListenerLeakError` (`code: DSH_FIXTURE_LISTENER_LEAK`). A failing host composition reaches the test as `HostAssemblyError` (`code: DSH_HOST_ASSEMBLY_FAILED`, with `stage`), which keeps the host's own error in a non-enumerable `hostError` property. Both are `Error` subclasses, never an `AssertionError`.
- R1, classifier (`classifyRunnerResult`) and CLI: on a failing run the order is now (1) a `DSH_FIXTURE_LISTENER_LEAK` line gives `INFRA_ERROR`, `test fixture leaked its HTTP listeners`; (2) an `AssertionError` outside the fixture's announcement lines and the stack frames beneath them gives `INCOMPATIBLE`; (3) a `DSH_HOST_ASSEMBLY_FAILED` line gives `NOT_VERIFIED` as before; (4) a load failure; (5) an unattributed origin. `firstFailure` recognises the leak line.
- R2: `skipIfHostUnassembled(t, error)` skips only for a `HostAssemblyError` and rethrows anything else.
- R3: `disposeComposition(ctx)` returns a dispose error instead of raising it. `reportHostAssemblyFailure(stage, error, cleanup)` prints the announcement and the host's first six stack frames first, then `DSH_FIXTURE_CLEANUP_FAILED <stage>: …` if the disposal threw. The test receives a `HostAssemblyError` for the original failure.
- Tests: six stock tests, two each in the unit, integration and preset files, and four watcher contracts, at the classifier, the real `node --test` reporter and the real CLI. Stock suites go from 125 to 131, watcher contracts from 41 to 45. The root-cause comment of the watcher contract is corrected; the message of `01ec7a8` is left as it was.
- Nothing changed outside `test/` and the two watcher functions: 7 files, 344 insertions and 42 deletions. `index.js`, `package.json`, both workflows, the runner script and the candidate recipe are as in the candidate.

## Red to green

Produced by the driver on the tested checkout:

1. **The watcher contracts against the classifier and CLI of `ab8c63f`**, both files restored from that commit and everything else at the tested commit: 45 tests, 40 pass, 5 fail. [superseded-classifier-and-cli-watcher.log](superseded-classifier-and-cli-watcher.log). The five are the host-attribution contract, the leak contract, the real-reporter contract, and the two real-runner contracts for a host row's own assertion and for a leaked listener.
2. **Thirteen mutants**, below: each contract of this change fails when its rule is removed, and nothing else fails.
3. **Green**: the formal run below.

Observed while the tests were being written, before the rules existed: the stock suite on rc.1 with 131 tests, 124 pass and 7 fail. The seven are the announced-host, assertion and cleanup contracts of both composition files and the leak self-check, each failing on behaviour. [fixture-red-rc1-r1-r3.log](fixture-red-rc1-r1-r3.log). It was run by the stock runner against the rc.1 tree in a scratch copy of this checkout whose path was not recorded, so the log is kept as it was produced and the mutants are the reproducible form of the same red. The two rules that this log does not cover, the skip rule and the guarded dispose, are red in their own mutants.

Kept from the record of `01ec7a8`. These are historical, bound to the candidate and to the first fix, and were not produced by this checkout's driver:

- **Baseline, candidate `0cbf5b2` unmodified, alpha.1, real watcher CLI**: `INFRA_ERROR`, `runtime regression timed out`, no test summary. [alpha1-baseline-infra-error-report.json](alpha1-baseline-infra-error-report.json), [alpha1-baseline-infra-error-run.log](alpha1-baseline-infra-error-run.log).
- **Watcher contracts of the first fix against the unmodified classifier and CLI**: 39/41. [watcher-red.log](watcher-red.log).
- **First version of the phase checks, on rc.1**: 121/123, failing with `Missing expected rejection`. [fixture-red-rc1.log](fixture-red-rc1.log).
- **Leak self-check alone on alpha.1, before the call sites were fixed**: 125 tests, 100 pass, 25 fail. [alpha1-selfcheck-red.log](alpha1-selfcheck-red.log).

## Executed validation

Managed command: `/usr/bin/python3 -I docs/acceptance/2026-11-24-alpha1-host-assembly/validate.py`.
Driver output: [validate-driver.out](validate-driver.out), last line `validate exit=0`.
Recorded run: `2026-11-24T09:07:02.488323+00:00` to `2026-11-24T09:17:25.958377+00:00`.
Node: Homebrew `24.22.3`, binary SHA256 `2c711dba4c61d710efa4e806dd87c6bf1532aa02afb95515c1c60efa0275ffec`.

| Scope | Result | Evidence |
| --- | --- | --- |
| Watcher contracts | 45/45 | [watcher.log](watcher.log) |
| Stock 0.2.2-rc.1 | 131/131 | [rc1.log](rc1.log) |
| Stock 0.2.2-rc.2 | 131/131 | [rc2.log](rc2.log) |
| Stock 0.2.2-rc.3 | 131/131 | [rc3.log](rc3.log) |
| Stock 0.2.2-rc.4 | 131/131 | [rc4.log](rc4.log) |
| Stock 0.2.2-rc.5 | 131/131 | [rc5.log](rc5.log) |
| Stock 0.2.3-alpha.2, freshly installed from the committed host lock | 131/131 | [alpha2.log](alpha2.log), [install-alpha2.log](install-alpha2.log) |
| Watcher `prepare`/`run`, 0.2.3-alpha.2 (`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`) | `COMPATIBLE` 131/131, 46.2 s | [alpha2-report.json](alpha2-report.json), [alpha2-prepare.log](alpha2-prepare.log), [alpha2-run.log](alpha2-run.log) |
| Watcher `prepare`/`run`, 0.2.3-alpha.1 (`d98f5d68519215da48f3002da2cb9c9d2068d81d`) | `NOT_VERIFIED`, 131 tests / 108 pass / 21 fail / 2 skipped, 41.2 s | [alpha1-report.json](alpha1-report.json), [alpha1-prepare.log](alpha1-prepare.log), [alpha1-run.log](alpha1-run.log) |
| Watcher `prepare`/`run`, 0.2.2-rc.5 (`9c2670d3bce5275e0d1610272958121af87787bb`) | `COMPATIBLE` 131/131, 53.6 s | [rc5-report.json](rc5-report.json), [rc5-prepare.log](rc5-prepare.log), [rc5-run.log](rc5-run.log) |
| Source package inspection | exit 0 | [pack.log](pack.log) |

All green suites have zero failed, cancelled, skipped or TODO cases. The alpha.1 cell was asserted in detail: the reason, exit code 1, the marker as first failure, Cordis 4.1.0, 21 marker lines and 21 `Error [HostAssemblyError]` lines for 21 failures, no assertion, leak, cleanup or timeout text, and under 120 s. All three cells share runner digest `59985b26f3c22e0458cb2f1002ba2c8e6c135333f403d195fe52a5c3d2cc2ece`.

[validation.json](validation.json) records exact argv, working directories, report and log digests and 19 tested file digests; those files were unchanged across the run and rechecked at its end. rc.2–rc.4 were installed into owned scratch directories with the pinned recipe of stable CI ([install-rc2.log](install-rc2.log), [install-rc3.log](install-rc3.log), [install-rc4.log](install-rc4.log)); rc.1 and rc.5 borrowed the documented existing stock trees read-only. HOME, TMPDIR, npm cache and every session store were isolated. The driver's scratch directory held no fixture leftover at the end and was removed. `git diff --check` is clean for the authored files; the raw logs keep, verbatim, the indented blank lines that the `node --test` reporter prints.

## Mutation checks

Each run is a scratch copy of the tested commit with one change, through the same runner or the watcher contracts. Every one exits non-zero within 23 s. Each rc.1 and watcher run is checked on its footer and on the names of its failing rows. The two alpha.1 leak mutants, whose failing rows are the 21 host failures, are checked on their footer and on the leak lines.

| Run | Result | Evidence |
| --- | --- | --- |
| Watcher contracts against the classifier and CLI of `ab8c63f` | 45 tests, 5 fail | [superseded-classifier-and-cli-watcher.log](superseded-classifier-and-cli-watcher.log) |
| Stage never cleared in both composition files (rc.1) | 131 tests, 2 fail: both "is not announced" phase checks. The plugin's own mount failure arrives wrapped as a host failure | [mutant-stage-never-cleared-rc1.log](mutant-stage-never-cleared-rc1.log) |
| Capacity cleanup registered after boot (alpha.1) | 132 tests, 22 fail: the hook names 10 leaked listeners | [mutant-capacity-cleanup-after-boot-alpha1.log](mutant-capacity-cleanup-after-boot-alpha1.log) |
| Composition moved out of the `try` (alpha.1) | 132 tests, 22 fail: the hook names 1 leaked listener | [mutant-callsite-boots-outside-try-alpha1.log](mutant-callsite-boots-outside-try-alpha1.log) |
| Classifier ignores the host marker | watcher 45 tests, 4 fail: the contracts that read the marker | [mutant-classifier-ignores-marker-watcher.log](mutant-classifier-ignores-marker-watcher.log) |
| Classifier ignores the leak line (R1) | watcher 45 tests, 3 fail: the contracts that expect a leak to be `INFRA_ERROR` | [mutant-classifier-ignores-leak-watcher.log](mutant-classifier-ignores-leak-watcher.log) |
| Classifier reads fixture lines as product evidence (R1) | watcher 45 tests, 3 fail: the contracts with an assertion inside a fixture announcement | [mutant-classifier-reads-fixture-lines-watcher.log](mutant-classifier-reads-fixture-lines-watcher.log) |
| Leak hook throws an `AssertionError` (R1) | 131 tests, 1 fail: the leak self-check | [mutant-leak-hook-asserts-rc1.log](mutant-leak-hook-asserts-rc1.log) |
| Leak hook closes the listeners without announcing or throwing (R1) | 131 tests, 1 fail: the leak self-check | [mutant-leak-hook-silent-rc1.log](mutant-leak-hook-silent-rc1.log) |
| Skip rule swallows unexpected errors (R2) | 131 tests, 1 fail: the skip rule | [mutant-skip-swallows-unexpected-errors-rc1.log](mutant-skip-swallows-unexpected-errors-rc1.log) |
| Host error also attached as `cause` (R1) | 131 tests, 2 fail: both "never thrown as an assertion" contracts | [mutant-host-error-also-cause-rc1.log](mutant-host-error-also-cause-rc1.log) |
| Cleanup failure not announced (R3) | 131 tests, 2 fail: both cleanup contracts | [mutant-cleanup-failure-unannounced-rc1.log](mutant-cleanup-failure-unannounced-rc1.log) |
| Dispose no longer guarded (R3) | 131 tests, 2 fail: both cleanup contracts | [mutant-cleanup-unguarded-rc1.log](mutant-cleanup-unguarded-rc1.log) |
| Host error rethrown as it was, in both composition files (R1, R3) | 131 tests, 6 fail: every announced-host contract | [mutant-host-error-rethrown-rc1.log](mutant-host-error-rethrown-rc1.log) |

A failing root hook is counted as one more test. That is why the two alpha.1 mutants show 132 tests and 22 failures: the 21 host failures and the hook's row; the two phase checks skip. In both, the leak is announced once and thrown as `Error [FixtureListenerLeakError]`, and the 21 host failures still print `Error [HostAssemblyError]`.

## Decisions for the reviewer

1. alpha.1 moves from `INFRA_ERROR` (red gate) to `NOT_VERIFIED` (warning plus an anomaly issue). This is intended: the gate stops being red while the alpha.1 issue stays open as a request for analysis. `NOT_VERIFIED` is cached, so later hourly runs reuse it until the plugin SHA, dependency lock or runner digest changes.
2. A leak outranks a host announcement and a product assertion alike. With a broken fixture the run is evidence of nothing, and `INFRA_ERROR` is never cached, so the next run re-tests the combination once the leak is fixed. A product assertion still wins over a host announcement. If a leak beside a product assertion should be reported `INCOMPATIBLE` rather than `INFRA_ERROR`, that is a reorder of two branches.
3. A host row's own assertion is `NOT_VERIFIED`, like any other host failure. The classifier sets the fixture's announcement lines and the stack frames beneath them aside before it looks for an assertion. The spec reporter prints this plugin's own assertion on a line of its own, the test's `✖` row or its `AssertionError [ERR_ASSERTION]: …` detail, so it is still found beside a host announcement. The price is that an `AssertionError` which appears only inside a stack frame, without such a line, is not read as this plugin's.
4. The host's error is kept in a non-enumerable `hostError` property, not as `cause`. The spec reporter prints a cause in full, which would put the host's assertion back into the output as a line of its own. The first six frames of the host's stack are printed beneath the announcement instead, so a report still says where upstream threw.
5. The skip rule skips for any `HostAssemblyError` of its precondition: a missing host package or a host configuration assertion during the composition is skipped the same as the alpha.1 fault. Every other error is rethrown.
6. A cleanup failure is reported on its own `DSH_FIXTURE_CLEANUP_FAILED` line and does not fail the test by itself; the test fails with the original host failure. The line is not a `cause`, for the reason in decision 4. The classifier sets it aside with the other fixture announcements.
7. Unchanged and older than this fix, and not changed here: when the composition fails after the host is up, in the plugin's own phase, the test receives the plugin's error and a dispose error from that path is not announced.
8. The report's first failure is the earliest line that matches. A run that both announces a host fault and leaks a listener is therefore classified `INFRA_ERROR` while its first failure names the host marker.
9. The two "is not announced" checks skip on a host that cannot assemble. Their precondition boots run under a mocked `console.error`, which is why the alpha.1 log has 21 marker lines for 21 failures, not 23.
10. Unchanged and older than this fix: a plugin mount failure that is not an `AssertionError` on a healthy host is `NOT_VERIFIED` (`test failure origin could not be attributed`), not `INCOMPATIBLE`. It is recorded here as an observation, not as something this change introduces or settles.
11. The runtime that alpha.1 would have provided is not exercised anywhere: its host never comes up, so alpha.1 stays unsupported and no fixture or product code is adapted to it.

## Quality gate and review boundary

Risk: behavior = attribution of a host that cannot be assembled, of a leaking fixture, and fixture cleanup; data = isolated JSONL only, no migration; security = no new permissions or credentials; contract = the stock suite runs unchanged on every supported host; irreversible = none. The upstream fault is not fixed here and cannot be: alpha.1's published packages need a Cordis static that its own lock does not provide.

Fallback analysis: none added. The announcements are lines printed at the throwing call site; the leak check is one root hook in each file that creates listeners.

Not exercised: a GitHub job for this HEAD or for `01ec7a8` (neither is pushed), Desktop GUI, installed profiles, real models, the alpha.1 runtime beyond the fact that it does not assemble, and a leaked listener whose close does not complete or throws. The leak hook ran with one listener in its rc.1 self-check and with one and ten in the two alpha.1 mutants. Local deadlines differ from Actions: `prepare` 240 s and `run` 180 s here, against the CLI's default six minutes there. A local run is therefore never longer than the Actions one.

The requested independent reviewer is Pro; acceptance returns to 砚砚62. Approval must bind the pushed HEAD. Merge, release, installation and restart remain separate actions without authorization.
