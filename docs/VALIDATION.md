# Validation record

Plugin version: **1.1.0** (cold compaction feature branch). Tested runtime: **DSH Desktop 0.12.1 / Harness 0.2.1-rc.2**. Recorded: **2026-10-27**.

This is a summary of the implementation review and local automated runs. Raw conversations, screenshots, machine configuration, and session logs remain outside this public repository. Desktop acceptance for 1.1.0 has **not** been run yet — code review comes first; the 1.0.1 Desktop acceptance below remains the reference for the shared live-window behavior.

## Automated checks

Run from the repository root with the matching DSH module tree linked at `node_modules`:

```sh
node --test --test-timeout=30000 test/unit.test.mjs test/integration.test.mjs test/cold.integration.test.mjs
```

The feature branch passes **47 tests: 37 unit, 1 live-window integration, 9 cold-path integration** (three consecutive full-green runs on 2026-10-27).

### Red/green reproduction for the cold feature

The cold suite fails against the 1.0.1 implementation and passes against this branch:

```sh
git checkout 40de6e65841db02fe28f37b0c0677916ac6248cd -- index.js package.json   # 1.0.1 live-only build
node --test test/cold.integration.test.mjs   # RED: 9 failing — cold-by-id rejected with "No live agent …"
git checkout HEAD -- index.js package.json                                  # this branch
node --test test/cold.integration.test.mjs   # GREEN: 9 passing
```

The headline red assertion is `cold compact failed: No live agent with session id "…" — only still-live (resident) subagents can be compacted`, which is exactly the 1.0.1 boundary this feature removes.

### What the cold suite proves (real DSH modules, isolated temp storage, local fake Messages SSE endpoint)

1. **Cold by id** — a real continuable child runs two turns, settles, and is reclaimed; `/subagent-compact <id>` succeeds without any new task; exactly one child-model summary request; `compaction/summary` + `compaction/end` persist; the maintenance writer is released (no live agent remains); the same id answers a follow-up afterwards, and the follow-up request context contains the checkpoint summary.
2. **Concurrent input** — with the summary deliberately delayed, three concurrent `subagents.sendMessage` deliveries during the open maintenance window all fail cleanly **before acceptance** (the persistence writer boundary rejects the competing cold resume); none appear in the child log; a retried send after release is delivered and answered exactly once.
3. **Authorization** — a foreign live parent, the caller itself, and a real grandchild are refused with history byte-identical before and after.
4. **Synthetic descriptor/lineage rejections** — crafted persisted sessions with a missing descriptor, a malformed descriptor, a version-2 descriptor, a one-shot descriptor, and a foreign-lineage header are each refused with the store untouched.
5. **Persisted pending input** — a crafted child with one durable pending inbox message is refused (`pending-input`) with the store untouched; a later normal continuation processes the pending message and the waking message exactly once each.
6. **Same-id contention** — a second concurrent compaction of the same id reports `busy-target`; the sequential re-run reports either nothing-to-compact, a further compaction, or the engine's own shrink refusal — never a double summary; exactly one committed summary overall.
7. **Cancellation and summary failure** — aborting mid-summary settles as a cancellation (the command layer may reject the execution with the abort error or return an error result; both accepted), no summary persists, the writer releases, and the child remains continuable; a scripted summary failure returns the engine's `summary` outcome with the attempt recorded, writer released, child continuable.
8. **Preset composition** — with a real agent-preset registry and the compaction engine mounted **only** inside an isolated preset group (no Host-plane engine composed), an independently selected child preset and a child model different from the parent's are restored; the single summary request runs on the child's model; the child continues normally after compaction.

### Honest scope of the automated proof

- The fake endpoint scripts turn and summary texts; summary **quality** is not evaluated.
- Concurrent sends are exercised at the deterministic points (writer definitely held during the delayed summary, and after release). The micro-window during restore (between `observeSession` and `persistence.open`) is not deterministically interleaveable without host hooks; both orderings resolve to one side winning the writer and the other failing/retrying cleanly.
- The release-boundary send (during `dispose()`) is approximated by the after-release retry; the dispose window itself is sub-millisecond and not controllable without hooks.
- Persistence-failure injection (e.g., disk errors during the compaction flush) was not automated; the engine's `persistence`/`commit` codes remain covered only by unit-level mapping tests.
- Plugin unload during a cold compaction is covered at unit level (abort + bounded settle + release); an integration unload race was not automated.

## Prior 1.0.1 record

### Automated checks (1.0.1)

`node --test test/unit.test.mjs test/integration.test.mjs` passed **26 tests: 25 unit tests and one integration test**.

The integration test verified the live-window journey: settlement and reclaim; cold resume by message; compaction during a running request waiting for idle; measured surface shrink from **1,564 to 273 estimated tokens**; persistence of compaction events; post-compaction follow-up; foreign-parent denial in a live window.

### Desktop acceptance (1.0.1)

The plugin was installed and enabled through Desktop's official plugin UI. Acceptance covered the no-argument listing command, the model tool, and the parameterized manual command. A real model summarized the child history, and the child retained three assigned facts during a follow-up without using file tools.

The parameterized command required an `input` descriptor in version 1.0.1. After replacing version 1.0.0, Desktop needed a full quit and reopen to publish the new command definition; refreshing the renderer did not suffice in this test.

For the manual command run:

| Measurement | Before | After | Meaning |
| --- | ---: | ---: | --- |
| Total context estimate | 20,245 | 16,716 | Harness token-meter total estimate |
| Nearest model-request total input | 20,237 | 17,195 | Provider usage, including cache reads |
| Replaced old history | 4,746 | — | Estimated old span, not net savings |

The request-input comparison includes a new follow-up message and runtime messages between requests. Its decrease of 3,042 tokens is an observed net change across that interval, rather than an isolated measure of compression savings. Cache-read and uncached input are disjoint in the tested adapter, so the total is their sum.

## Release provenance

The 1.0.1 public distribution's `index.js` SHA-256:

```text
534aff3a38bf5fdc1e0d5554b3b1a959aad510dcc55c73ee6970dc63db90d872
```

The 1.1.0 feature branch is pre-review; its distribution hash will be recorded after independent review and Desktop acceptance. Compatibility and summary quality on other runtime or model versions remain unverified.
