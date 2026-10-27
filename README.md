# DSH Subagent Compactor

[简体中文](README.zh-CN.md)

Manually compact a direct subagent's history from its parent session in DSH Desktop — while the child is live, **or after it finished** by restoring its persisted session by id. The plugin reuses the child's own compaction engine and provides a chat command and a model tool.

**Version:** `1.1.0` · **Package:** `@local/dsh-subagent-compactor` · **Tested with:** DSH Desktop `0.12.1` / Harness `0.2.1-rc.2`.

## What changed in 1.1.0

A finished continuable child can now be compacted by its session id without starting another task or racing the live window: the plugin restores the persisted session through the public `agents.resume` with the composition the subagent manager itself restores (descriptor route, independently selected agent preset or inherited composition, persona, tool filter), runs one idle compaction, and releases the writer it created. See [TECHNICAL.md](TECHNICAL.md) for the authorization, pending-input, and concurrency rules.

## Install in DSH Desktop

1. Open **Plugins → Add plugin** (中文界面：**插件 → 添加插件**).
2. Paste this Git source into the package name or address field:

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.1.0
   ```

3. Select **Install → Enable now**. Confirm that `@local/dsh-subagent-compactor` version `1.1.0` is running.
4. After replacing an existing installation, fully quit and reopen Desktop. In the tested Desktop version, a renderer refresh could leave an old command definition active.

If this package is already installed from a local directory, uninstall that source before adding the Git source. The package name stays the same.

Desktop's plugin manager handles installation and the bundle patch. Keep the host-provided peer modules; no manual profile edits or npm publication are required. `private: true` prevents npm publication and permits this Git installation path.

You can also clone the repository and select its root directory in **Add plugin**:

```sh
git clone https://github.com/08mamba24/dsh-subagent-compactor.git
cd dsh-subagent-compactor
git checkout v1.1.0
```

For an immutable install target, replace `v1.1.0` in the Git source with the full 40-character commit from this repository.

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

The parent model can call the same operation through:

```text
compact_subagent({ "session_id": "<subagent-session-id>" })
```

You can ask the parent: “Call `compact_subagent` for child session X and report the tool result.” A tool call remains subject to the host's permissions.

## Confirm the result

The command must execute as a command card, rather than appear as an ordinary model message. A successful result identifies the child session, summary sequence, and replaced history items. The tool returns `outcome`, `target_session_id`, `summary_seq`, `replaced_items`, and `replaced_tokens`.

`replaced_tokens` estimates the old history that was replaced. It does **not** measure net savings after adding the summary. To measure savings, compare the child's context estimate or total request input before and after compaction. The summary uses one additional model request on the child's own route.

Refusals are explicit outcomes, never silent: `unknown-session` (no live or persisted session), `not-authorized` (foreign parent / grandchild / self), `unsupported-target` (one-shot, external, missing or unsupported descriptor), `pending-input` (persisted unfinished input — continue the child instead), `busy-target` (a concurrent compaction or another live writer; retry), `restore-failed`, `query-unavailable`, plus the engine's six manual-compaction codes (`busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`).

## Requirements and limits

- The composition must provide `commands`, `tools`, `agents`, and `subagents`, plus a compaction engine for the target child. Normal subagent-capable Desktop presets provide these services. Cold compaction additionally needs `sessionQuery` and session persistence (present in the same compositions).
- Only the exact runtime parent can compact its direct child. Other parents, the caller itself, and grandchildren are rejected — for live targets through runtime ownership, for finished targets through the child's persisted header lineage and its durable descriptor.
- Preset compositions resolve the child's engine through `agentPresets.serviceFor` (no Host-plane fallback); compositions without that registry use the Host engine.
- A finished child with persisted pending input is refused (`pending-input`) so that work survives for a normal continuation; if the pending appears only in the loaded snapshot (a racing writer), the restored session stays resident until that input is processed instead of being cancelled.
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

The integration suites use isolated temporary storage and a local fake model endpoint. They make no external model calls and delete their test storage afterward. `test/cold.integration.test.mjs` is the 1.1.0 feature suite; run it against the `1.0.1` `index.js` to see the cold-by-id journeys fail (red), and against this branch to see them pass (green) — see [docs/VALIDATION.md](docs/VALIDATION.md).

## Source and license

This repository distributes the plugin source and installation instructions. A license has not yet been specified. The package remains private for npm publication; GitHub installation is the distribution method for this release.
