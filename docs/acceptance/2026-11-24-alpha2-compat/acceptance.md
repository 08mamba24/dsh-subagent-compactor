# Alpha.2 compatibility candidate acceptance

Date: 2026-11-24 (Asia/Shanghai). Author: cat-yanyan61 / gpt-6.1-sol.
Base: `0917cb3c6adece6fa1bad9b849fbc9de7089a323`.
Checkout: `/Users/yuhan/codespace/dsh-subagent-compactor-alpha2`, branch `fix/alpha2-compat`.

## Agreement and result

The operator asked us to keep following Harness upgrades, identify the failures and upgrade changes, and use Pro for independent review. Pro's diagnostic review (`thread_mw53zll89rzl8b3o#0001795452330981-000503-8c459e14`) requested a formal candidate with the public import, precise optional-auth handling, Node 24.22.3 and an alpha.2 host-lock CI job, while retaining rc.1–rc.5.

That source candidate is implemented. The six stock module trees each pass **120/120**, the watcher passes **39/39**, and package inspection succeeds. The candidate has not been installed, pushed, merged, tagged or released; GitHub jobs and Desktop GUI acceptance have not been executed for this HEAD.

## Changes

- Product: change the runtime `CommandDefinitionId` import from the removed `/brand` subpath to the existing public package root. Existing commands, ownership proof, capacity handling and compaction calls are unchanged.
- Fixtures: load the alpha.1+ auth service before the API-key provider in both real compositions. A shared helper resolves the target first, accepts only the exact target-package-missing error, and imports outside that catch. Broken entries and missing transitive dependencies propagate.
- Candidate preparation: install the exact published `@deepseek-ai/dsh` host and its own vendor closure. Record core vendor/service versions; do not mix rc.1 development vendor pins into alpha.2.
- CI: use Node 24.22.3; preserve the five stable RC jobs and add an isolated alpha.2 job using checked-in `npm ci` inputs. No issue-write permission or notification gate was broadened.

The alpha.2 lock reuses the previously verified published host graph. Its 774 non-root package records are identical to the diagnostic lock; only root package identity and the exact direct host version replace the scratch manifest. The graph comparison is independent of root formatting:

- Original lock SHA256: `b5db12f2c30f2db6974acfaf574f000879bdcd31a5e114be30fce4b81b088858`.
- Candidate lock SHA256: `3102f0405d3c1f6d72f88f305a1f138ef973a70b105ee1cc2d1fedf6c24bf5ad`.
- Non-root graph SHA256: `cdbb523c6b9bb57e95fb5a762f1261f5e9b05c8f6c6477acd2c158db5c7233c6` (UTF-8 JSON, keys sorted, compact separators, no trailing LF).

## Red to green

The targeted checks were run before the final implementation; their initial failures are in the session tool transcript, not separately reconstructed as raw log files here.

1. The diagnostic broad `ERR_MODULE_NOT_FOUND` catch passed the absent/present cases but failed the missing-transitive-dependency case (`Missing expected rejection`, 2/3 pass).
2. Catching resolution alone still hid an installed legacy package with a missing entry (3/4 pass). Restricting the catch to the exact absent target made all **4/4** pass. The final matrix includes those cases in every host run.
3. The candidate-prepare contract check failed against the old recipe because it included Cordis 4.1.0 and other development pins. It passes with the exact host closure.
4. The first full watcher run exposed a synthetic installer fixture missing the newly installed root host manifest (38/39). The fixture now models that successful install; the final watcher run is **39/39**. The runtime error classifier and timeout behavior were not weakened.

## Executed validation

Managed command: `/usr/bin/python3 -I docs/acceptance/2026-11-24-alpha2-compat/validate.py`.
Managed job: `managed-job-c7a8d8f74a76e56d04277c82ce91e6c90a3b46f7`, exit 0.
Recorded run: `2026-11-23T16:55:19.963598+00:00` to `2026-11-23T17:01:02.340105+00:00`.
Node: Homebrew `24.22.3`, binary SHA256 `2c711dba4c61d710efa4e806dd87c6bf1532aa02afb95515c1c60efa0275ffec`.

| Scope | Result | Evidence |
| --- | --- | --- |
| Watcher contracts, real timeout/report and notification regressions | 39/39 | [watcher.log](watcher.log) |
| Stock 0.2.2-rc.1 | 120/120 | [rc1.log](rc1.log) |
| Stock 0.2.2-rc.2 | 120/120 | [rc2.log](rc2.log) |
| Stock 0.2.2-rc.3 | 120/120 | [rc3.log](rc3.log) |
| Stock 0.2.2-rc.4 | 120/120 | [rc4.log](rc4.log) |
| Stock 0.2.2-rc.5 | 120/120 | [rc5.log](rc5.log) |
| Stock 0.2.3-alpha.2, freshly installed from the committed host lock | 120/120 | [alpha2.log](alpha2.log), [install-alpha2.log](install-alpha2.log) |
| Source package inspection | exit 0 | [pack.log](pack.log) |

All suites have zero failed, cancelled, skipped or TODO cases. [validation.json](validation.json) records exact argv, working directories, lock digests, log digests and 19 tested file digests; those files were unchanged across the run and rechecked before committing. rc.2–rc.4 were installed into owned scratch directories with the same pinned recipe as stable CI; rc.1 and rc.5 borrowed the documented existing stock trees read-only. Every HOME, npm cache and session store created by the driver was isolated and cleaned up. No diagnostic native preload was used.

Additional checks: `git diff --check` passes; both changed workflow files parse with the installed YAML parser. `actionlint` was unavailable, so YAML parsing is not claimed as full Actions semantic validation. The branch had no GitHub PR at the read-only check; no GitHub workflow was triggered.

## Quality gate and review boundary

The module journey runs the real Cordis/Loader composition, creates continuable children, invokes the actual plugin commands, waits for compaction, checks durable summaries and same-ID continuation, and tests cross-parent denial, concurrency and cancellation. Model responses are loopback synthetic data. This supports the compatibility candidate; it does not establish real-model summary quality, GUI interaction, SQLite support or installed Desktop activation. alpha.1's full runtime was not tested.

Risk: behavior = one public import plus fixture/CI changes; data = isolated JSONL only, no migration; security = no new permissions or credentials and stricter missing-package classification; contract = public DSH export/auth/vendor closure; irreversible = none. Architecture map delta: none; existing plugin, test and CI owners remain the same.

Fallback analysis: no new product fallback. The shared fixture has one version boundary for an absent auth package; missing entry/transitive errors rethrow. No file adds three fallback layers. This external repository has no family fallback-check script; the changed call sites were inspected directly.

The requested independent reviewer is Pro. This is a formal local product candidate, distinct from the earlier three-file scratch patch and DSH-PLUGIN evidence commits. Approval must bind the new product HEAD; installation, restart, merge and release are separate actions.
