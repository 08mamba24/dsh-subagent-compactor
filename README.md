# DSH Subagent Compactor

[简体中文](README.zh-CN.md)

Manually compact a live direct subagent's history from its parent session in DSH Desktop. The plugin uses the child's existing compaction engine and provides a chat command and a model tool.

**Version:** `1.0.1` · **Package:** `@local/dsh-subagent-compactor` · **Tested with:** DSH Desktop `0.12.1` / Harness `0.2.1-rc.2`.

## Install in DSH Desktop

1. Open **Plugins → Add plugin** (中文界面：**插件 → 添加插件**).
2. Paste this Git source into the package name or address field:

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1
   ```

3. Select **Install → Enable now**. Confirm that `@local/dsh-subagent-compactor` version `1.0.1` is running.
4. After replacing an existing installation, fully quit and reopen Desktop. In the tested Desktop version, a renderer refresh could leave an old command definition active.

If this package is already installed from a local directory, uninstall that source before adding the Git source. The package name stays the same.

Desktop's plugin manager handles installation and the bundle patch. Keep the host-provided peer modules; no manual profile edits or npm publication are required. `private: true` prevents npm publication and permits this Git installation path.

You can also clone the repository and select its root directory in **Add plugin**:

```sh
git clone https://github.com/08mamba24/dsh-subagent-compactor.git
cd dsh-subagent-compactor
git checkout v1.0.1
```

For an immutable install target, replace `v1.0.1` in the Git source with the full 40-character commit from this repository.

## Use it

Use the command in the parent session that created the subagent:

```text
/subagent-compact
```

This lists the parent's persisted direct-child catalog. Copy a full child session ID, then invoke:

```text
/subagent-compact <subagent-session-id>
```

**The child must still be live when the request starts.** Invoke while it is running; the default `waitForIdle: true` waits for its turn to finish before compacting. A catalog entry can outlive its running agent, so listing an ID does not prove it is currently compactable. A settled child returns `not-resident`; this plugin does not resume it.

The parent model can call the same operation through:

```text
compact_subagent({ "session_id": "<subagent-session-id>" })
```

You can ask the parent: “While this direct child is still running, call `compact_subagent` for its session ID. Report the tool result.” A tool call remains subject to the host's permissions.

## Confirm the result

The command must execute as a command card, rather than appear as an ordinary model message. A successful result identifies the child session, summary sequence, and replaced history items. The tool returns `outcome`, `target_session_id`, `summary_seq`, `replaced_items`, and `replaced_tokens`.

`replaced_tokens` estimates the old history that was replaced. It does **not** measure net savings after adding the summary. To measure savings, compare the child's context estimate or total request input before and after compaction. The summary uses an additional model request.

## Requirements and limits

- The composition must provide `commands`, `tools`, `agents`, and `subagents`, plus a compaction engine for the target child. Normal subagent-capable Desktop presets provide these services.
- Only the exact runtime parent can compact its live direct child. Other parents, the caller itself, and grandchildren are rejected.
- Preset compositions resolve the child's engine through `agentPresets.serviceFor`; compositions without that registry use the Host engine.
- This release provides listing and manual compaction. Child deletion, handoff, cold-session compaction, and automatic triggers are outside its scope.
- Compatibility was verified on the versions above. Later Harness versions require verification.

See [technical details](TECHNICAL.md) and the [validation record](docs/VALIDATION.md).

## Run the tests

Tests need a module tree from Harness `0.2.1-rc.2`, including its runtime packages. Point the ignored `node_modules` link at that tree:

```sh
DSH_MODULES="/absolute/path/to/dsh/node_modules"
ln -s "$DSH_MODULES" node_modules
node --test --test-timeout=30000 test/unit.test.mjs test/integration.test.mjs
```

The integration test uses isolated temporary storage and a local fake model endpoint. It makes no external model calls and deletes its test storage afterward.

## Source and license

This repository distributes the plugin source and installation instructions. A license has not yet been specified. The package remains private for npm publication; GitHub installation is the distribution method for this release.
