# DSH Subagent Compactor

[简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

Manually compact the history of **direct subagents** from their parent session in DSH Desktop — children that are still live, and settled *continuable* children by resuming them first. The plugin uses each child's existing compaction engine and keeps the child usable on the same session ID.

**Status: 1.3.3 local compatibility candidate, pending independent review; not pushed, tagged or released.** This candidate targets stock Harness **0.2.2-rc.1 and 0.2.2-rc.2** without changing Desktop application code. The previous 1.3.2 implementation is incompatible with rc.2; its rc.1 validation remains historical evidence.

## Install

Open **Plugins → Add plugin**, paste a Git source, and select **Install → Enable now**:

| Version | Git source |
| --- | --- |
| Published 1.0.1, single live-child compaction | `https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1` |
| Previous 1.3.2 source, rc.1 only | `https://github.com/08mamba24/dsh-subagent-compactor.git#20981ebade6a260bd4a497916b450baeebe5372d` |

The 1.3.3 candidate exists only on the local `fix/rc1-rc2-compat` branch. The Git sources above refer to older public versions; neither is this candidate. There is no `v1.3.3` tag or daily-profile deployment.

Confirm that `@local/dsh-subagent-compactor` is enabled and shows the intended version. After replacing an existing installation, fully quit and reopen Desktop to load the new command definition. If the same package was installed from a local directory, remove that installation source before adding the Git source.

Desktop's plugin manager handles the bundle configuration. No manual profile edit, host patch, or npm publication is needed. The package's `private: true` prevents npm publication and permits Git installation.

## Use it

Run commands in the parent session that created the children:

```text
/subagent-compact
/subagent-compact <subagent-session-id>
/subagent-compact all
```

- **No argument:** lists the parent's persisted direct-child catalog. Each entry is marked `live` or `persisted (not loaded)`. The list is an observation, not a reservation.
- **One session ID:** compacts that direct child. A still-live child is compacted through its idle window (`waitForIdle: true` by default). A settled *continuable* child is resumed first — the plugin sends one real maintenance wake message, compacts at the resume edge, and the wake is answered by a normal turn afterwards. Children that cannot resume (one-shot, external, or unrestorable) return an explicit refusal such as `not-resumable`.
- **`all` or `--all`:** takes one catalog snapshot and starts all child attempts concurrently. Live children compact directly; settled continuable children wait for host capacity before resuming. Each admitted resume sends one wake message. Results retain catalog order. Settled non-continuable or unrestorable children are `skipped` with their reason; one child's failure does not hide the other results. Children created after the snapshot belong to the next run.

A successful two-child batch (both children had settled) ends with a result such as:

```text
<child-1>: resumed from settled state and compacted — replaced 3 items (...)
<child-2>: resumed from settled state and compacted — replaced 3 items (...)
Summary (completed) — total 2: compacted 2 (2 after resume), nothing-to-compact 0, skipped 0, failed 0, cancelled 0, not-started: 0.
```

`completed` allows skipped children but requires at least one compacted or nothing-to-compact result. A run where nothing was compacted at all reports `nothing-compacted` and is an error, never an implied success. Read the individual lines and the `compacted` count to see how much work ran. The batch covers direct children of this parent only, with no recursion into grandchildren.

**Resuming a settled child costs real conversation.** Each resume sends one maintenance wake message; the child's history is summarized (one summary-model request on its own route), then the wake is answered by one short acknowledgment turn. This is a live exchange, not an offline transaction: if the summary fails, the already-delivered wake message still runs, and the receipt says so. The wake text asks only for a maintenance acknowledgment — it never instructs new work. Set `resumeInactive: false` to restrict every surface to children that are live right now.

The parent model has one tool:

```text
compact_subagent({ "session_id": "<subagent-session-id>" })
```

It uses the same single-child path and follows the host's tool permissions. Batch compaction is available through the command; this version does not expose a batch model tool.

## Confirm the result

The slash command should execute as a command card. A successful item identifies the child, replaced history items, and summary sequence in that child's log. The model tool returns `outcome`, `target_session_id`, `summary_seq`, `replaced_items`, and `replaced_tokens` on success.

`replaced_tokens` estimates the old history span that was replaced. It is not the net context saving after adding the summary. Each actual compaction makes one summary-model request on the child's own route, and each resume adds the wake-acknowledgment turn afterwards. A child whose remaining history is too short for a useful summary fails honestly with the engine's `summary` code (the wake stays delivered); retrying after the child accumulates more history is the usual fix.

Compaction summaries persist through the host's session storage. Batch output is only the command result: this version has no separate receipt store or `report` command, and the host may discard a cancelled command's result.

## Requirements and limits

- A normal subagent-capable composition must provide `commands`, `tools`, `agents`, `subagents`, and the child's compaction engine. Listing and batch discovery require the host's persisted child catalog. On rc.2, single-target authorization also requires `sessionQuery` and its `subagentCatalog` projection.
- Only the exact live runtime parent may compact its direct child. Self, grandchildren, and another parent's children are rejected.
- Settled continuable children are resumed through the normal continuation lifecycle (one real wake message, one summary, one acknowledgment turn). One-shot, external, or unrestorable children get explicit refusals, never silent drops. A same-ID instance *swap* during an idle wait still refuses conservatively with `not-resident`.
- All live items enter their idle waits immediately. Resume attempts obey the host's shared pool, waiting for actual slot release after settlement and disposal. Model rate limits and non-capacity errors remain individual failures; they are not retried as capacity shortages.
- Missing engines, changed residency, contention, cancellation, and engine failures produce explicit outcomes. See [TECHNICAL.md](TECHNICAL.md).
- The plugin provides manual commands and one model tool. It adds no automatic compaction trigger, deletion, or handoff operation.

## Capacity waiting

When active children fill the host's pool, settled targets wait for a slot to be released. The same behavior applies to the batch, single-ID command, and model tool. Live children keep their concurrent idle waits. The plugin does not change the host limit or stop existing work.

If another message restores a target while it waits, compaction switches to the live path without sending a maintenance wake. If that restoration is still queued inside the host when a send begins, only the pending maintenance delivery is cancelled; the external task continues.

`resumeCapacityTimeoutMs` defaults to **120000** (two minutes), configurable from **1 to 600000** milliseconds in the plugin settings. The budget starts at the first capacity rejection and ends when admission succeeds; it does not limit an admitted summary or acknowledgment turn. A target still waiting at the deadline reports `capacity-timeout`, including the host's capacity diagnostic. Cancellation and plugin unload also stop the wait. A capacity-rejected attempt sends no accepted wake and makes no model request.

## Changes from the unreleased 1.1.0 candidate

The old candidate combined cold compaction with a host maintenance patch. The 1.2.0 preview moved to stock runtime capabilities and live-only compaction; the current branch keeps that base and adds settle-and-resume for continuable children (the comparison below is the historical 1.2.0 snapshot):

| Surface | Unreleased 1.1.0 candidate | 1.2.0 preview (historical) |
| --- | --- | --- |
| Finished, unloaded child | Cold restore through a candidate host patch | Single command refuses; batch skips |
| Batch execution | Serial | Concurrent, with output in catalog order |
| Model tools | `compact_subagent`, `compact_all_subagents` | `compact_subagent` only |
| Batch receipts | Plugin storage domain and `report <batch-id>` | Command result only |
| Host changes | Required for cold compaction | None on the validated stock runtime |

[host-patch/](host-patch/README.md), [the cold plan](docs/COLD_COMPACTION_PLAN.md), [host requirements](docs/HOST_MAINTENANCE_REQUIREMENTS.md), and the older acceptance records remain as **legacy documentation for that unreleased candidate**. They are not installation steps or supported APIs for the current branch. Upgrading from that candidate removes its cold path, batch tool, report syntax, and durable batch receipts.

## Validation and tests

Both the recorded installed-runtime validation and a clean npm dependency-tree run passed **46/46 tracked tests at the 1.2.0 preview point** (unit 25, batch 15, integration 1, preset 5); the historical 1.3.2 baseline passed **92/92** (unit 35, batch 40, integration 3, preset 14) on stock Harness `0.2.2-rc.1`. The 1.3.3 candidate passes **109/109 tests on each runtime** (authorization 14, unit 35, batch 40, integration 3, preset 17), including a 16-settled-child batch under the default eight-slot limit and direct-parent boundary checks. An isolated run of the application's bundled Web UI compacted two live children, read both summaries back from disk, continued both original IDs, and confirmed the checkpoints in subsequent model requests.

The Web UI run used a local synthetic model endpoint. It verifies the command and persistence path, not real-model summary quality or operation of the user's daily Electron window. See [docs/VALIDATION.md](docs/VALIDATION.md) and the [live-only acceptance summary](docs/acceptance/2026-11-10-live-only/acceptance.md).

With Node **24.9.0 or newer**:

```sh
npm ci --include=dev
npm test
```

To test another extracted stock tree, run `node scripts/test-installed-runtime.mjs --modules /absolute/node_modules`. The runner accepts only rc.1 or rc.2 and checks all required dsh packages agree on that version. CI runs both package trees. These module-level tests do not claim a new native Electron-window acceptance.

The five tracked suites use pinned stock runtime packages, isolated temporary storage, and a local fake model endpoint. They make no external model requests.

## Source and license

This repository distributes the plugin source and installation instructions. A license has not yet been specified. Git installation remains the distribution method; no npm package is published.
