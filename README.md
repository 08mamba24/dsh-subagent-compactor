# DSH Subagent Compactor

[简体中文](README.zh-CN.md)

**Status: unreleased 1.1.0 candidate.** The cold-compaction feature below is code-review approved but **not released**: it requires the candidate host maintenance capability (`ctx.subagents.runMaintenance`, see [host-patch/](host-patch/README.md)). On a stock DSH 0.2.1-rc.2 runtime the plugin refuses cold compaction explicitly (`host-capability-missing`); only live-window compaction works there. The currently released version is **1.0.1** (live-window only).

Manually compact a direct subagent's history from its parent session in DSH Desktop — while the child is live, **or after it finished** by its session id. The plugin reuses the child's own compaction engine and provides a chat command and a model tool.

**Candidate version:** `1.1.0` (unreleased) · **Package:** `@local/dsh-subagent-compactor` · **Validated against:** DSH Desktop `0.12.1` / Harness `0.2.1-rc.2` (live window: released runtime; cold path: isolated patched tree).

## What changed in 1.1.0

A finished continuable child can be compacted by its session id on the candidate patched host, without starting another task or racing the live window. The plugin calls `ctx.subagents.runMaintenance`; the manager restores the child's composition, runs the compaction job, and owns settlement and writer release. The plugin holds no restored handle. See [TECHNICAL.md](TECHNICAL.md) for the authorization, pending-input, and concurrency rules.

## Install in DSH Desktop

### Released version (1.0.1, live-window compaction)

1. Open **Plugins → Add plugin** (中文界面：**插件 → 添加插件**).
2. Paste this Git source into the package name or address field:

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1
   ```

3. Select **Install → Enable now**. Confirm that `@local/dsh-subagent-compactor` version `1.0.1` is running.
4. After replacing an existing installation, fully quit and reopen Desktop. In the tested Desktop version, a renderer refresh could leave an old command definition active.

If this package is already installed from a local directory, uninstall that source before adding the Git source. The package name stays the same.

Desktop's plugin manager handles installation and the bundle patch. Keep the host-provided peer modules; no manual profile edits or npm publication are required. `private: true` prevents npm publication and permits this Git installation path.

### 1.1.0 candidate (NOT installable as a released tag)

The 1.1.0 candidate has **no tag and no release**: it exists as the `feature/cold-session-compaction` branch plus the candidate host patch. Do not install it into a real Desktop expecting cold compaction — the stock runtime lacks the required capability, and the plugin will refuse cold compaction explicitly. To evaluate the candidate, use the isolated verification tree described in [host-patch/README.md](host-patch/README.md). For an immutable reference, cite the exact 40-character commit of the branch head instead of a tag.

## Use it

Use the command in the parent session that created the subagent:

```text
/subagent-compact
```

This lists the parent's persisted direct-child catalog. Each line ends with `— live` (a loaded agent) or `— persisted (not loaded)` (a record whose agent is not loaded; a listing is an observation, not a reservation). Copy a full child session ID, then invoke:

```text
/subagent-compact <subagent-session-id>
```

Two lawful situations:

- **Child still live** — invoke while it is running; the default `waitForIdle: true` waits for its turn to finish before compacting.
- **Child finished** (a continuable child that settled and was reclaimed) — invoke by id at any later time. The plugin restores the child, compacts once, and releases it; no new task is sent. The same id stays continuable afterwards.

### Batch: compact every direct child at once

```text
/subagent-compact --all
```

Compacts every child in **one durable catalog snapshot** of the calling parent, taken when the run starts (children spawned afterwards belong to the next run; no recursion into grandchildren, no other parents' children). Items run **serially** under the same per-target locks — a concurrent single compaction of the same child reports `busy-target`. Each item reports its own outcome and reason (compacted with its summary seq / replaced items / replaced-history token estimate, nothing-to-compact, refused for unsupported mode or pending input, engine failure, …); one child's failure never hides the rest. The batch outcome is `completed` only when every child compacted or had nothing to compact, `all-failed` when nothing succeeded, `partial-failure` in between, and `batch-cancelled` when it was cancelled — including a cancellation that lands while the catalog read is still resolving; every non-clean outcome makes the command report an error, never success. Cancelling (or unloading the plugin) stops children that have not started yet — reported as `not-started` — and keeps every finished result. Because the host's abort semantics drop a cancelled command's own result, the finished per-child report is kept on the plugin: the bare `/subagent-compact` listing appends the last batch report whenever the last batch did not complete cleanly (the store lives with the plugin — a restart forgets it; each child's own session log is the durable record). Each compacted child still costs one summary request on its own model route. On a stock runtime the cold items are refused (`host-capability-missing` counts as failed) while live items still compact.

The parent model can call the same operations through:

```text
compact_subagent({ "session_id": "<subagent-session-id>" })
compact_all_subagents({})   // the batch above, with structured counts
```

You can ask the parent: “Call `compact_subagent` for child session X and report the tool result.” A tool call remains subject to the host's permissions. The batch tool's counts — `total`, `compacted`, `nothing_to_compact`, `failed`, `cancelled`, `not_started` — are structured values from the batch result, never numbers parsed back out of the report text (error lines may contain arbitrary digits).

## Confirm the result

The command must execute as a command card, rather than appear as an ordinary model message. A successful result identifies the child session, summary sequence, and replaced history items. The tool returns `outcome`, `target_session_id`, `summary_seq`, `replaced_items`, and `replaced_tokens`.

`replaced_tokens` estimates the old history that was replaced. It does **not** measure net savings after adding the summary. To measure savings, compare the child's context estimate or total request input before and after compaction. The summary uses one additional model request on the child's own route.

Refusals are explicit outcomes, never silent: `unknown-session` (no live or persisted session), `not-authorized` (foreign parent / grandchild / self), `unsupported-target` (one-shot, external, missing or unsupported descriptor), `pending-input` (persisted unfinished input — continue the child instead), `busy-target` (a concurrent compaction or another live writer; retry), `restore-failed`, `query-unavailable`, plus the engine's six manual-compaction codes (`busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`).

## Requirements and limits

- The composition must provide `commands`, `tools`, `agents`, and `subagents`, plus a compaction engine for the target child. Normal subagent-capable Desktop presets provide these services. Cold compaction additionally needs `sessionQuery` and session persistence (present in the same compositions).
- Only the exact runtime parent can compact its direct child. Other parents, the caller itself, and grandchildren are rejected — for live targets through runtime ownership, for finished targets through the child's persisted header lineage and its durable descriptor.
- Preset compositions resolve the child's engine through `agentPresets.serviceFor` (no Host-plane fallback); compositions without that registry use the Host engine.
- Cold compaction uses the host's manager-owned maintenance capability (`ctx.subagents.runMaintenance`). On a stock 0.2.1-rc.2 runtime the plugin refuses cold compaction explicitly (`host-capability-missing`); the isolated candidate host patch in [host-patch/](host-patch/README.md) provides the capability, under which accepted input is never lost, normal routes keep working throughout, and unloading the plugin preserves parked input. Live-window compaction works everywhere.
- This release provides listing and manual compaction. Child deletion, handoff, and automatic triggers are outside its scope.
- Compatibility was verified on the versions above. Later Harness versions require verification.

See [technical details](TECHNICAL.md) and the [validation record](docs/VALIDATION.md).

## Run the tests

Tests need a module tree from Harness `0.2.1-rc.2`, including its runtime packages. Point the ignored `node_modules` link at that tree:

```sh
DSH_MODULES="/absolute/path/to/dsh/node_modules"
ln -s "$DSH_MODULES" node_modules
node --test --test-timeout=30000 test/unit.test.mjs test/integration.test.mjs test/cold.integration.test.mjs
```

The integration suites use isolated temporary storage and a local fake model endpoint. They make no external model calls and delete their test storage afterward. `test/cold.integration.test.mjs` is the 1.1.0 candidate's contract suite: on the isolated patched tree (see [host-patch/README.md](host-patch/README.md)) all suites pass (74/74 — unit 41, integration 1, cold 32); on a stock tree point `node_modules` at it and run `GAP_DIAG=1 node --test --test-name-pattern "cold R2" test/cold.integration.test.mjs` for the capability-missing diagnostics. Full evidence history: [docs/VALIDATION.md](docs/VALIDATION.md).

## Source and license

This repository distributes the plugin source and installation instructions. A license has not yet been specified. The package remains private for npm publication; GitHub installation is the distribution method for this release.
