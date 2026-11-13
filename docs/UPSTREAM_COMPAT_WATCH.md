# Upstream compatibility watch

This document describes `.github/workflows/upstream-compat.yml`. The workflow is an early compatibility signal for new official DeepSeek Harness versions. It does not approve or perform a plugin release, a daily Desktop installation, or a Harness upgrade.

## When it runs

- Scheduled at minute 23 of every hour. GitHub schedules can start late and run only from the default branch.
- Manually through **Actions → Upstream compatibility watch → Run workflow**.
- Manual input `tag` accepts one exact official `dsh-v...` tag. `force_recheck` ignores an exact cached result for that manual run.

There is deliberately no `release` trigger: a release event in this repository cannot observe releases in `deepseek-ai/deepseek-harness`.

## Discovery and identity

The discovery job reads both official GitHub releases and tags. It includes prereleases and RCs, excludes drafts, and enriches every selected release with the exact commit from its Git tag. The scheduled window contains the three most recent DSH tags; every new tag therefore enters the window even if it is published only as a tag.

A result is deduplicated by all of the following:

1. this plugin repository's exact Git SHA;
2. the Harness tag and exact tag commit;
3. the public npm dependency-lock digest resolved for that Harness version;
4. the installed-runtime runner digest.

An exact GitHub Actions cache key stores the prior classified report. A matching scheduled combination becomes `SKIPPED` and does not update an issue. A manual forced recheck runs again but does not overwrite the immutable cached result.

## Test boundary and classifications

The compatibility job has read-only repository permission and checks out with persisted Git credentials disabled. It receives no user credentials. Public dependency locks and installs use a fresh HOME and empty npm configuration; package lifecycle scripts are disabled. The stock suite then uses the repository's `scripts/test-installed-runtime.mjs`, which creates isolated temporary DSH_HOME, DSH_AGENTS_HOME and JSONL state. Runtime integration tests route model calls to their loopback synthetic endpoint.

The report has three substantive outcomes:

| Classification | Meaning |
| --- | --- |
| `COMPATIBLE` | The stock installed-runtime suite ran and passed. |
| `INCOMPATIBLE` | The supported stock runner executed and the compatibility suite failed. |
| `NOT_VERIFIED` | The runner does not support that version, or the exact public dependency set is unavailable. This is not an incompatibility result. |

Dependency/network failures that prevent an otherwise testable run are `INFRA_ERROR`. `INCOMPATIBLE` and `INFRA_ERROR` make the final watch gate red. `NOT_VERIFIED` produces an Actions warning and requires manual analysis, but is never rewritten as a green compatibility claim.

The report records the first failure, output tail, resolved package versions, lock digest, Harness tag/commit, plugin SHA, and workflow URL. Artifacts are retained for 30 days.

## Notifications and permissions

Discovery and compatibility jobs have only `contents: read`. They never receive issue-write permission. A separate notification job runs only for scheduled executions on the default branch and has narrowly scoped `issues: write` plus `contents: read`.

For a newly tested combination, that job creates or updates one issue titled `[upstream-compat] <Harness tag>`. Repeated exact combinations are skipped. Uncacheable retries also compare a semantic fingerprint before editing, so an unchanged result does not create comments or issue activity every hour. Re-testing the same Harness version after the plugin SHA changes updates the same issue rather than opening a duplicate.

An issue is a request for analysis. Even `COMPATIBLE` does not authorize installing, tagging, releasing, or upgrading a daily Desktop environment.

## Relationship to fixed CI

`.github/workflows/ci.yml` remains the release-candidate gate for its explicit, pinned Harness matrix. The upstream watcher only discovers and classifies newer combinations. It does not edit the product implementation, the fixed CI matrix, or the installed-runtime runner's supported versions.

If a new upstream version is `NOT_VERIFIED (runner unsupported)`, adding runner support is a separate reviewed change. If it is `INCOMPATIBLE`, diagnose the first failing stock test before changing product code; a fix requires a new SHA and normal review.

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
- The watch remains local/unpushed in this branch; `schedule` activates only after merge to main.
