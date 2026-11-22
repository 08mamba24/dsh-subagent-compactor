# Upstream compatibility watch — author acceptance, 2026-11-22

## Entrusted outcome

The user accepted hourly upstream release/tag discovery, isolated compatibility
regressions, deduplicated anomaly issues, and distinct compatible/incompatible/
unverified/infrastructure outcomes. The follow-up explicitly asks to detect
future rc.6/rc.7 changes promptly. Sources are this thread's messages
`0001795313272011-000440-9098ffc0` and
`0001795313571953-000444-4bc95d85`; Task
`0001795313352751-000443-81c48e52` owns delivery.

## Observed results

- Node 24.22.3; stock rc.1–rc.5 each passed all five tracked suites:
  **116 tests, 116 passed, zero failed/cancelled/skipped/TODO** per version.
- rc.3–rc.5 additionally traversed the actual watcher `prepare` → `run` CLI,
  with fresh public npm dependency trees, lifecycle scripts disabled, temporary
  homes/storage, and loopback synthetic models. Each report is `COMPATIBLE` and
  carries the exact tag commit, plugin source SHA, lock/runner digests, package
  versions, exit status and full test counters. Runtime source was
  `5c5c56a68259a0ea3311b8d00ecb531eeb0a84b8`.
- The initial watcher regression suite passed **24/24**; the review repair
  below raises that to **27/27**. Future-version fixture tests
  run genuine `node --test` bodies through the candidate wrapper while proving
  the fixed runner still rejects an unknown version and candidate/package
  mismatches. These are synthetic wiring tests, not rc.6/rc.7 compatibility claims.
- Unordered future tags, numeric rc.10 versus rc.7, and stable-versus-RC
  precedence are covered. Live discovery selected the official rc.5/rc.4/rc.3
  with their exact tag commits.
- Notification tests cover a never-delivered cached anomaly, one issue per
  tag, recovery update/close, an identical later cached result causing no write,
  and a newly healthy version creating no issue.
- `npm pack --dry-run`, YAML parsing, and the source/docs whitespace check
  excluding archived `docs/acceptance/**/*.log` passed. Raw negative-control
  logs retain their original whitespace; the full archived-log diff is not
  claimed clean. The plugin product implementation (`index.js`) is unchanged from main.

## Negative controls

`runner-support-red.log` rejects the previous rc.1/rc.2 baseline.
`future-candidate-red.log` runs the new tests against the pre-candidate runner:
the direct future probe fails, and the watch stops at `NOT_VERIFIED` instead of
executing the synthetic test bodies. `notify-red.log` shows the old notifier
creating healthy-version issues and failing to close recovery. `version-order-red.log`
shows the old API-order window missing newer versions. Each failure is at its
intended observable assertion before the corresponding implementation change.

## Independent review repair

Astra's review of `a5cf272` found that a successful issue edit followed by a
transient reopen failure could leave the anomaly permanently closed: the next
run saw the new fingerprint and incorrectly returned `unchanged`.

The notifier now reconciles the desired issue state before treating identical
content as delivered. Three stateful real-CLI regressions cover `INCOMPATIBLE`,
`NOT_VERIFIED` and `INFRA_ERROR`: edit succeeds, reopen returns HTTP 502, the
second call retries reopening, and a third identical call performs no write.
All three fail on the old implementation at the expected CLOSED-versus-OPEN
assertion (`reopen-retry-red.log`), then pass with the repair. The whole watcher
suite passes **27/27** (`watch-reopen-green.log`). The existing compatible/open
close-retry branch was also inspected; it already reconciles state before
deduplication. No product/runtime implementation, dependency or UI changed.

## Activation and limits

The schedule is minute 23 of every hour after merge to main. PR runs exercise
read-only discovery/testing/aggregation; only scheduled main runs or explicit
manual main notification runs can update issues. Fresh healthy results remain
in Actions. Cached verdicts retain provenance and remain deliverable after a
notification failure; an unchanged fingerprint stays quiet.

Independent review and real remote Actions/activation receipts are attached to
the associated PR. This pre-merge author record does not establish an enabled
schedule. It does not claim future RCs already pass, real-model summary quality,
native Electron acceptance, a release/tag, or a daily installation change.

GitHub can delay or drop scheduled runs, and public repositories with no
activity for 60 days can have schedules disabled; see the
[official schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Reproduction

With Node 24.9 or newer, run `npm run test:upstream-watch` and the five fixed
stock CI entries. To probe another isolated stock package tree:

```sh
node scripts/test-installed-runtime.mjs --modules /absolute/node_modules
node scripts/test-installed-runtime.mjs --modules /absolute/node_modules --candidate-version exact-version
```

For the full watcher path, run `scripts/upstream-compat.mjs prepare` with the
exact official tag, tag commit, plugin SHA and absolute scratch/report paths,
then `run --plan /absolute/plan.json --report /absolute/report.json`. Its public
dependency lock is generated before installation and retained in Actions artifacts.
