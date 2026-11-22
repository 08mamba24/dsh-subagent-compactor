# Upstream compatibility watch

This document describes `.github/workflows/upstream-compat.yml`. The workflow is an early compatibility signal for new official DeepSeek Harness versions. It does not approve or perform a plugin release, a daily Desktop installation, or a Harness upgrade.

## When it runs

- Scheduled at minute 23 of every hour. GitHub schedules can start late and run only from the default branch.
- Pull requests that change the watcher, runtime runner, tests, or plugin run the read-only discovery/test/report path before merge. They cannot publish issues.
- Manually through **Actions → Upstream compatibility watch → Run workflow**.
- Manual input `tag` accepts one exact official `dsh-v...` tag. `force_recheck` ignores an exact cached result for that manual run.
- Manual input `notify` defaults to false. Selecting it on main exercises the same anomaly/recovery notification path as a scheduled run.

There is deliberately no `release` trigger: a release event in this repository cannot observe releases in `deepseek-ai/deepseek-harness`.

## Discovery and identity

The discovery job reads both official GitHub releases and tags. It includes prereleases and RCs, excludes drafts, and enriches every selected release with the exact commit from its Git tag. The scheduled window contains the three highest DSH versions by semantic precedence, independent of API ordering; rc.10 sorts above rc.7, and a stable release above its own RCs. Newer versions enter the window even when published only as tags. Older backports outside that window can be selected manually by exact tag.

A result is deduplicated by all of the following:

1. this plugin repository's exact Git SHA;
2. the Harness tag and exact tag commit;
3. the public npm dependency-lock digest resolved for that Harness version;
4. the installed-runtime runner digest.

An exact GitHub Actions cache key stores the prior classified report. A matching combination becomes `SKIPPED`; its effective verdict can still be delivered if a prior notification failed. A manual forced recheck runs again and saves a fresh result-digest key when the verdict changes.

## Test boundary and classifications

The compatibility job has read-only repository permission and checks out with persisted Git credentials disabled. It receives no user credentials. Public dependency locks and installs use a fresh HOME and empty npm configuration; package lifecycle scripts are disabled. The stock suite then uses the repository's `scripts/test-installed-runtime.mjs`, which creates isolated temporary DSH_HOME, DSH_AGENTS_HOME and JSONL state. Runtime integration tests route model calls to their loopback synthetic endpoint.

The fixed runner and CI matrix cover rc.1–rc.5. The watcher supplies `--candidate-version <exact discovered version>` and attempts the complete suite even for a future rc.6, rc.7, or later tag. The runner verifies the installed version matches that candidate and that every required dsh package agrees before testing. A new tag does not require a manual allowlist edit. `runnerSupportedVersions` and `runnerSupportsVersion` in the plan describe the fixed baseline; they do not prevent candidate execution.

The report has three substantive outcomes:

| Classification | Meaning |
| --- | --- |
| `COMPATIBLE` | The stock installed-runtime suite ran and passed. |
| `INCOMPATIBLE` | The suite failed with assertion evidence attributable to the compatibility tests. |
| `NOT_VERIFIED` | The exact public dependency set is unavailable, the suite could not load, or execution evidence is missing or unattributable. This is not an incompatibility result. |

Dependency/network failures that prevent an otherwise testable run are `INFRA_ERROR`. `INCOMPATIBLE` and `INFRA_ERROR` make the final watch gate red. `NOT_VERIFIED` produces an Actions warning and requires manual analysis, but is never rewritten as a green compatibility claim.

The report records the first failure, output tail, resolved package versions, lock digest, Harness tag/commit, plugin SHA, and workflow URL. Artifacts are retained for 30 days.

## Notifications and permissions

Discovery and compatibility jobs have only `contents: read`. They never receive issue-write permission. A separate notification job runs only on the default branch, for scheduled runs or a manual run with `notify=true`, and has narrowly scoped `issues: write` plus `contents: read`.

An anomaly (`INCOMPATIBLE`, `NOT_VERIFIED`, or `INFRA_ERROR`) creates or updates one issue titled `[upstream-compat] <Harness tag>`. Healthy versions remain in the Actions report without creating issues. Recovery updates and closes an existing issue. Notifications compare a semantic fingerprint, so an unchanged result does not create comments or issue activity every hour. Re-testing the same Harness version after the plugin SHA changes updates the same issue rather than opening a duplicate. A discovery or incomplete-artifact failure stays a failed Actions run; it cannot be presented as a complete per-version result.

An issue is a request for analysis. Even `COMPATIBLE` does not authorize installing, tagging, releasing, or upgrading a daily Desktop environment.

## Relationship to fixed CI

`.github/workflows/ci.yml` remains the release-candidate gate for its explicit, pinned Harness matrix. The upstream watcher only discovers and classifies newer combinations. It does not edit the product implementation, the fixed CI matrix, or the installed-runtime runner's supported versions.

If a new upstream version is `NOT_VERIFIED`, inspect the unavailable package, load failure or missing evidence before changing the fixture. If it is `INCOMPATIBLE`, diagnose the first failing stock test before changing product code; a fix requires a new SHA and normal review. Candidate results do not automatically change the fixed matrix, plugin dependencies, installation or published tags.

## Local verification

Run the deterministic watcher unit tests:

```sh
npm run test:upstream-watch
```

Exercise live discovery without changing GitHub state:

```sh
node scripts/discover-upstream.mjs \
  --repository deepseek-ai/deepseek-harness \
  --limit 3 \
  --output /tmp/dsh-upstream-discovery.json
```

After the workflow has been merged, open the workflow run in **Actions** and download `upstream-compat-summary`. Its JSON is the machine-readable verdict; its Markdown is also written to the run summary. Per-version artifacts contain the dependency manifest, lockfile, plan, and detailed report.

## Result validation and delivery (2026-11-13 review fixes)

- **Terminal-state validation:** `aggregate` no longer trusts report counts alone. It validates every discovered target against exactly one report (`tag`/`version`/`commit` matching, plugin SHA present), rejects intermediate (`PREPARED`), unknown, missing, duplicate, or unexpected reports as infrastructure failures, and emits `complete=true` only when every target holds a terminal verdict. Gate flags (`has_incompatible`, `has_not_verified`) read the **effective** verdict — a cached `SKIPPED` run keeps the verdict it recorded — while `skipped_count` reports this run's cache hits separately.
- **Delivery decoupled from testing:** `notify` delivers the effective verdict of cached results too. A combination whose issue was never created (first manual run, or a failed earlier notification) gets its issue on the next scheduled run; an identical already-delivered fingerprint stays `unchanged`. Re-delivery never re-runs the stock suite.
- **Cache refresh under immutability:** save keys embed the result digest (`v2-<combo>-<resultDigest>`). Restores use the key prefix and `inspect` validates the restored report against the exact combination; a changed verdict saves a fresh entry and later runs pick the new verdict, without needing to overwrite an existing cache key.
- These fixes originated in the unmerged candidate; `schedule` activates only after merge to main. The 2026-11-22 revision adds future-version candidate execution and anomaly/recovery notifications. See the dated acceptance record for actual execution status.
