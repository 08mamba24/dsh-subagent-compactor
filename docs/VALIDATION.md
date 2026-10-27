# Validation record

Plugin version: **1.1.0** (cold compaction feature branch, review round 2). Tested runtime: **DSH Desktop 0.12.1 / Harness 0.2.1-rc.2**. Recorded: **2026-10-27**.

This is a summary of the implementation review and local automated runs. Raw conversations, screenshots, machine configuration, and session logs remain outside this public repository. Desktop acceptance for 1.1.0 has **not** been run yet — code review comes first; the 1.0.1 Desktop acceptance below remains the reference for the shared live-window behavior.

## Review round 4 (R3: manager-owned maintenance, isolated candidate patch)

Per review round 3's direction ("no more compensation layers; converge the lifecycle capability"), this round delivers a **minimal host patch + thin plugin call**, verified in an isolated module tree; no installed artifact, the shared evidence tree, or any real profile is touched, and nothing is merged/tagged/pushed/installed.

- **Host source baseline**: `deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`, patched in a clean worktree (`host-patch/0001-…diff`, reviewable). The same changes applied one-to-one to the two compiled `lib/index.js` files (`0002`/`0003`) build the isolated verification tree `host-patched/node_modules` (all other packages symlinked to the stock tree).
- **Plugin baseline**: this branch; the cold branch is now a thin `ctx.subagents.runMaintenance(caller, id, { signal, job })` call — the plugin holds no restored handle, and the drain/strand compensation machinery from rounds 1–2 is deleted. On a stock runtime the plugin refuses cold compaction explicitly (`host-capability-missing`).
- **Round-3 corrections implemented**: the engine's `compactNow` is the only maintenance window (the manager holds the activation lifecycle and the settlement reservation — no nested `runMaintenance`); the admission cutoff is at the loop input layer (`send` checks `closeInput` synchronously before the durable enqueue — `activation.closing`, direct `followup/steer/inject`, and handle teardown share ONE boundary; no check-then-dispose); `keepInbox` covers the claimed-but-uncommitted batch too (restored on abort, verified by message id, order, and exactly-once); unloading only the plugin leaves the host alive with parked input intact.

### Acceptance-contract evidence (patched tree, default mode)

`node --test test/unit.test.mjs test/integration.test.mjs test/cold.integration.test.mjs` → **55/55, three consecutive green runs**. The contract regressions, rewritten as record-then-assert (accepted → processed exactly once with an answer, or rejected explicitly with nothing enqueued; success is honest when the input's fate is safe):

1. **Release cutoff** (reviewer's dispose-wrapper proof, as a formal regression): the attempt at the cutoff is either rejected by the loop-level cutoff or fully processed; zero `outcome:"canceled"` splices.
2. **Normal routes with injected pending** (reviewer's second-writer proof): `sendMessage` and the addressed `prompt({delivery:"queue"})` deliver while the child holds pending work; the injected sentinel is processed exactly once with an answer.
3. **Plugin-only unload with parked pending** (reviewer's fiber-unload proof): the Host stays alive, parked input survives with zero cancellations, and the SAME message id is processed exactly once by a later continuation.
4. **Concurrent normal-route sends during the summary window**: all accepted and delivered exactly once (the old writer-collision refusal is gone — residency is the boundary now).
5. **Admission cutoff, both sides**: before the cutoff input is accepted and processed; after `closeInput()`, `followup`/`steer`/`inject` all throw before the durable enqueue and nothing reaches the log.
6. **Claimed-input abort (`keepInbox`)**: an aborted running turn restores its claimed-but-uncommitted batch (or it was already committed exactly once); zero cancellations; exactly-once overall after continuation.
7. The R1 regressions (window input fully processed before release across success/cancellation/summary-failure; precheck-race work preserved) remain green under the new lifecycle.

### Stock-tree diagnosis (explicit mode)

With `node_modules` pointing at the stock 0.2.1-rc.2 tree: `GAP_DIAG=1 node --test --test-name-pattern "cold R2" test/cold.integration.test.mjs` → **3/3 green** (each test asserts the stock runtime lacks `ctx.subagents.runMaintenance` and the plugin refuses cold compaction explicitly). Running the full cold suite on the stock tree without `GAP_DIAG` fails as expected — that is the honest capability statement, not a regression.

## Review round 3 (R2: contract vs. stock gap)

Review of `c2017f1` found the R1 fix incomplete (a check-then-dispose window still drops input accepted in that window; the strand blocks every normal continuation route with `NOT_RESUMABLE`; plugin unload cancels parked input) and redirected the work: stop stacking compensations, pin the lifecycle capability gap, and propose the host-side fix. All three reviewer proofs were reproduced on `c2017f1` before this round:

- release-cutoff wrapper proof — sentinel accepted after the empty check, dropped by the release, compaction still reported success;
- strand-normal proof — 3× `sendMessage` and the addressed `prompt({delivery:"queue"})` all `NOT_RESUMABLE` while the strand held the writer (`stillLive`, `stillPending`);
- plugin-only unload proof — `ctx.compactorFiber.dispose()` left `removedCount:1, outcome:"canceled"` and an empty inbox.

Deliverables of this round: **no new plugin mechanism**. The three proofs became self-inverting dual-mode regressions — green in *gap* mode (asserting today's documented loss), red in *contract* mode (`EXPECT_HOST_MAINTENANCE=1 node --test test/cold.integration.test.mjs`, asserting the acceptance contract) — plus `docs/HOST_MAINTENANCE_REQUIREMENTS.md`, the manager-owned `runMaintenance` proposal (gaps A+C) with a lossless-unload teardown option (gap D), an explicit "stock 0.2.1-rc.2 is insufficient" conclusion, and a real-route verification plan. The two unit tests that had celebrated the lossy unload dispose were removed; the stranding message in `index.js` now states plainly that it is not a recovery path.

The R1 regressions (sentinel processed before release in the success/cancel/summary-failure windows; precheck-race work preserved and completed via the public input surface) remain green and unchanged — they are the parts of the contract the stock runtime can already honor.

## Review round 2 (R1/P2 fixes)

The independent review of commit `2c9bc5e` returned REQUEST_CHANGES with one P1: the cold handle's unconditional dispose durably cancelled accepted input — the write lock does not fence the published Agent's public input surface (`followup`/`steer`/`inject` via `agents.get(id)`), and a legal second persistence writer can enqueue pending between the read precheck and the writer open. Both red proofs were reproduced against `2c9bc5e` before the fix:

- `node /tmp/dsh-cold-direct-message-proof.mjs` — a `followup` sentinel accepted mid-summary was inserted at seq 26, then cancelled by the release (`{removedCount: 1, outcome: "canceled"}`), never reaching the model.
- `node /tmp/dsh-cold-precheck-race-proof.mjs` — pending injected between precheck and load was refused but then cancelled by the rollback dispose; `pendingInbox` ended empty.

### The fix

- **Release cutoff** (`drainRestoredAgent`): after the compaction settles (success, failure, or cancellation), the plugin waits for the restored agent to become idle **and** its inbox to hold no accepted-but-unprocessed input before disposing. Input accepted during the maintenance window is latched by the loop, wakes a real turn, and is fully processed (durable `user/message` + assistant answer) before release; an empty inbox makes the teardown cancel a no-op, so accepted input is never durably cancelled.
- **Stranding**: pending found in the **loaded** snapshot (precheck-race input, or no-wake injections) refuses compaction and strands the restored handle on a background drain — the pending work stays durable and untouched, and the handle releases once that input is actually processed (the next public input wakes the loop and consumes the queue). Same-id compaction during residency serializes on the live path.
- **Unload termination**: every drain and strand is an unload-abortable operation; unload terminates through the ordinary dispose — the same teardown any live agent takes. Input still parked at unload can be cancelled by that termination, matching the manager's own stop semantics. This is the residual loss window (host gap below).
- **P2**: `withComposition` now runs boot inside the guard and removes its temp storage in `finally` (verified: no leftover `subagent-compactor-it-*` dirs).

### Host capability gap (reported to review)

`AgentHandle.dispose` cannot release a restored handle while preserving accepted input — its teardown unconditionally cancels a non-empty inbox, and no public wake exists that does not inject a message. Hence the residency for no-wake pending and the unload caveat. A `dispose({ keepInbox })`-equivalent, or a resume variant whose validation rollback writes nothing, would remove both.

### R1 regression suites (new; all red on 2c9bc5e, green after the fix)

- `cold R1: input accepted during the maintenance window is fully processed before release` — sentinel `followup` mid-summary; asserts a durable `user/message` + assistant answer, **zero** `outcome:"canceled"` inbox splices, writer release, and exactly-once continuation of the same id.
- `cold R1: accepted input also survives cancellation and summary failure of the compaction` — the same guarantees hold when the compaction is aborted mid-summary or fails its shrink check.
- `cold R1: pending injected between precheck and load strands without cancelling work` — controlled interleaving (wrap of the public resume entry + a second legal persistence writer, the reviewer's own technique): compaction refused, no summary request, no cancellation splice, the injected work reaches the model with an answer after a public input advances the strand, writer releases, normal continuation answers exactly once.
- Unit: drain waits for accepted input then disposes; loaded-snapshot pending strands (no dispose while pending; unload terminates through dispose); unload during the cutoff terminates through the ordinary dispose.

### Automated checks

Run from the repository root with the matching DSH module tree linked at `node_modules`:

```sh
node --test --test-timeout=30000 test/unit.test.mjs test/integration.test.mjs test/cold.integration.test.mjs
```

The branch passes **53 tests: 40 unit, 1 live-window integration, 12 cold-path integration** (three consecutive full-green runs on 2026-10-27; temp storage cleanup verified).

### Red/green reproduction for the cold feature (round 1, still applies)

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
- Manager-routed concurrent sends are exercised at the deterministic points (writer definitely held during the delayed summary, and after release); the public Agent input surface (`followup` during the window, plus a racing second writer before the load) is covered deterministically by the R1 suites. Remaining micro-windows (a send landing inside `observeSession`→`open` or inside `dispose` itself) are not deterministically interleaveable without host hooks; every ordering resolves into one of the proven arms (manager refusal before acceptance, stranding, or drain-before-release).
- The release-boundary send (during `dispose()`) is approximated by the after-release retry and the drain cutoff; the dispose window itself is sub-millisecond and not controllable without hooks.
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
