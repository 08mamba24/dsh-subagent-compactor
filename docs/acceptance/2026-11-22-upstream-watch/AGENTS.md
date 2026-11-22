# Upstream compatibility watch evidence

`acceptance.md` describes this run's scope and limits. `evidence.json` and the
per-version reports preserve exact source identities, dependency digests and
executed-test counts. `discovery.json` was generated from current official
GitHub API data read through the canonical CLI.

All runtime logs use isolated temporary stores and loopback synthetic models.
`*-red.log` files are intentional negative controls; the green logs record the
implemented behavior. The synthetic future-version fixture tests only the
runner/watch wiring, not compatibility with an unreleased Harness version.

Do not add credentials, daily profiles, real user sessions or raw npm caches.
Later remote Actions and activation receipts belong in the associated PR;
this dated author-side record does not by itself prove schedule activation.
