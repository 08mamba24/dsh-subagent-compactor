# Plan: compact a persisted child session by ID

Status: implementation plan, not a released capability. Target: plugin 1.1.0.
Baseline: 1.0.1, commit `40de6e65841db02fe28f37b0c0677916ac6248cd`.
Runtime under test: DSH Desktop 0.12.1 / Harness 0.2.1-rc.2.

## User outcome

From the direct parent session, the user supplies a continuable child session ID after the child has finished. The plugin loads the authorized persisted session when needed, compacts its history, saves it, and leaves it usable for a later continuation.

The user does not need to start another task, send a dummy message, or race the child's settlement watcher. An ordinary completed child with useful history must pass this journey; reporting `not-resident` is not a successful completion of this feature.

Keep both entry points:

```text
/subagent-compact [session-id]
compact_subagent({ "session_id": "..." })
```

The no-argument listing should distinguish persisted-only records from loaded agents and show loaded status when available. Describe observation time honestly; listing a record is not a reservation.

## Established evidence

- Current `index.js:162-164` only calls `agents.get(id)` and returns `not-resident` when absent. It never loads the persisted child.
- The public `agents.resume({ resumeSessionId, parentAgent, agentOptions, signal, setup })` returns a new owned AgentHandle. It loads persisted state without requiring a new user task.
- `compaction.compactNow(agent, signal, commandId?)` enters the idle agent's maintenance phase and flushes the committed result. It does not prohibit history merely because the previous agent was reclaimed.
- An isolated probe using real Harness modules, an empty inbox, a Host composition, and a local scripted model completed: real child settlement/reclamation → old command rejection → public resume by original ID → idle compaction → release → persisted summary. It made no additional ordinary task request, only one summary request; the context estimate fell from 1,565 to 273 tokens. This proves the basic path, not Desktop preset restoration or concurrent-input safety.

## Implementation shape

Split the operation into target resolution/ownership, compaction, and release. Command and tool must share this path.

1. Validate the exact calling Agent is still live. If the target is already live, keep runtime `agents.isOwnedBy` authorization and the existing engine/maintenance behavior. Never dispose an existing target borrowed from another owner.
2. If the target is absent, observe the persisted session through `sessionQuery.observeSession(id, { signal })`. Authorize the direct parent from the authoritative child header and supported subagent descriptor before opening a maintenance writer. A catalog record alone is insufficient authorization.
3. Admit only a supported local continuable child for the cold path. Reject unknown identity, foreign child, self, grandchild, external/one-shot, missing history, unsupported descriptor, and incompatible restoration with a clear outcome. A legitimate temporary busy condition may be reported; absence from the live registry alone may not be the reason.
4. Reconstruct the original child composition through public APIs, acquire exclusive ownership, and resolve the engine in the target's correct realm. Do not submit an ordinary task to create the maintenance window.
5. Call the composed engine, preserve the six-code and signal-first error contract, checkpoint the result, and release only resources created by this operation. Cancellation, failure, and plugin unload must also release or transfer ownership without discarding accepted messages.

A per-target operation lock can serialize compaction requests. It does not, by itself, serialize the host's message admission or make disposal safe.

## Restore the child's actual configuration

Use the public root exports of `@deepseek-ai/dsh-subagent`: `foldSubagentDescriptor`, `SUBAGENT_DESCRIPTOR_VERSION`, and `applyChildComposition` where applicable. Do not call private manager methods or copy the entire subagent manager.

- Read the child's own events after `inheritedEventCount`; a fork's inherited descriptor is not the child's descriptor.
- Restore descriptor `agentProvider`, `agentModel`, and `agentReasoningEffort` with their original optional semantics. Descriptor `provider` denotes the subagent backend, not the LLM provider. Do not replace the child's route with the parent's current route.
- Match the official distinction between an independently selected preset and inherited composition. An independent selection precedes the child's first own descriptor; obtain its current ID from the preset projection. Missing or unavailable selected presets fail explicitly.
- Apply the selected preset or `composeFrom`, plus descriptor persona and tool filter, through `applyChildComposition` in resume setup. The setup wrapper returns void; do not accidentally return a preset mount receipt as a setup commit object.
- Preserve session metadata, working directory, depth, and durable permission events through the normal persistence path. Do not overwrite them with the parent's current settings.
- Do not restore activation-only options such as the old output schema or maxTokens. Do not use the delegation-time `resolveChildAgentOptions` as a cold-restoration shortcut.
- With a preset registry, resolve `serviceFor(restoredAgent, "compaction")` after setup. Do not fall back to a Host engine if that preset engine is absent.

Declare any new hard-imported peers as required and align them with the tested Harness version; avoid installing a second Host runtime into the plugin.

## Message admission and release: first implementation checkpoint

Resolve this before calling the feature complete:

- A handle made by generic `agents.resume` is present in the Agent registry but is not automatically a managed subagent Activation. Team/child delivery may try a second cold resume and hit the maintenance writer's ownership lock. Do not treat that as successful delivery or assume those messages automatically queue in the maintenance handle.
- `runMaintenance` can park direct inbox inputs and wake them afterward. A subsequent `handle.dispose()` calls cancellation without `keepInbox` and can discard accepted work. A one-time empty-inbox check immediately before disposal is not an admission fence.
- For each real input route, an accepted message must survive and later be processed once. A competing send that cannot be admitted may fail clearly before acceptance; it must not return a false success. Prove the actual behavior and document any retry outcome.
- Check durable pending inputs before materializing a cold maintenance target. A busy refusal must preserve the original pending work; never restore, discover queued work, and then dispose it away.
- Use supported lifecycle/ownership mechanisms. Do not clear inboxes, patch `cancel`, mutate private registries, fake completion events, or modify user session logs to make the test pass.

The implementer should first identify and test a supported admission/release boundary. If the installed public interfaces cannot preserve accepted inputs across that boundary, return the exact failing interleaving and smallest missing host capability for review. Do not silently reduce the feature back to live-only or claim the empty-inbox probe proves the missing guarantee.

## Required verification

Start with a failing regression for the existing cold-ID rejection. Use isolated stores and local fake model endpoints for automated tests.

1. **Completed cold child:** real local continuable child finishes and is reclaimed; invoke by ID without another task; compact a nonempty span; confirm summary/end events, persistence, writer release, and later normal continuation of the same ID.
2. **Desktop-style composition:** run a real preset-registry composition, including an independently selected child preset and a routed child model that differs from the parent's current model. Assert correct summarizer route, persona/tool restrictions, and no Host engine fallback. The existing Host-only probe is insufficient.
3. **Authorization:** foreign parent, self, grandchild, malformed/missing descriptor, fork inherited prefix, unsupported child mode, and unavailable preset. Denials leave history unchanged.
4. **Concurrent real input:** deliver through actual `subagents.sendMessage`/addressed continuation at controlled points during restore, summary, and release. Assert each send is either accepted and ultimately delivered once, or rejected before acceptance. Check legitimate direct inbox routes too; do not substitute a plugin-only lock for this test.
5. **Pending inputs and failure cleanup:** cold persisted pending messages, cancellation at each resource-acquisition stage, summary failure, persistence failure, and unload. Pending work survives and a later normal continuation can process it; no writer or AgentHandle leaks.
6. **Same-ID contention:** concurrent compaction and a competing normal resume do not operate on a stale Agent instance or double-own the writer. Existing live, six-code, cancellation, and TOCTOU regressions remain green.
7. **Human journey:** in a designated acceptance session, allow a real child to finish, then run `/subagent-compact <id>` from its parent. Confirm the command card, child log summary, context measurement with stated token semantics, and successful subsequent continuation. Do not infer success from a model's prose.

## Delivery and review

Implementation belongs in this standalone plugin repository. Preserve the package identity and both entry points; bump the plugin to 1.1.0 when the feature is ready for acceptance. Update both READMEs and the validation record to match the actual supported states and failure outcomes.

Return the exact commit, changed files, red/green reproduction commands, test output, and unverified boundaries for independent review. Code review approval and Desktop acceptance are separate facts. Do not overwrite v1.0.1, install into an unrelated live profile, or claim a release before the new source is reviewed and the acceptance result is recorded.
