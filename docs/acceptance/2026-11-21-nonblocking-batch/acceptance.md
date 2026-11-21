# No-argument batch command acceptance

Date: 2026-11-21. Candidate: plugin 1.3.4, based on `b374e45`.

The new `/subagent-compact-all` registers without an input descriptor and awaits the existing batch operation. The stock UI releases the composer while the host keeps the command running until the real result is available. The original parameterized command and model tool remain on the same locks, authorization, cancellation, and compaction path.

## Automated regression

Node 24.22.3 ran all five tracked suites against separate stock Harness rc.1 and rc.2 module trees: **116 passed, zero failed or skipped on each tree**. The six focused new behavior tests fail against the previous product source, where the standalone registration is absent. Packaging with `npm pack --dry-run` also passed.

The first candidate run exposed an error in the new test: it read buffered parent command events before flushing the session. The test now calls `ctx.sessions.flush(parent.session)` before reading JSONL. This did not change product summary durability. The initial failing log is retained alongside the final results.

To reproduce the automated checks with Node 24.9.0 or newer:

```sh
npm ci --include=dev
npm test
node scripts/test-installed-runtime.mjs --modules /absolute/path/to/rc2/node_modules
npm pack --dry-run
```

## Stock bundled Web UI

The installed Harness **0.2.2-rc.5**, build `3f85d888b1297107937d9bd5b853f7e733e179a4`, served its actual Web UI through `dsh web --no-open --host 127.0.0.1 --port 0`. A headless Chromium context drove the real composer. Scratch HOME, DSH_HOME, DSH_AGENTS_HOME, workspace, and JSONL storage separated this run from daily profiles. A loopback synthetic Messages service held summary responses until the interaction checks finished.

The plugin source SHA-256 was `cd273040b0bc0605504b3475df767907cd0d0a8fecf16667deff2d8ccdf44711`.

| Journey | Observed result |
| --- | --- |
| Direct `/subagent-compact-all`, two naturally settled continuable children | Both summary requests held at once; one command/run and no command/done while pending; typing, deleting, and system clipboard paste worked; release produced two durable summaries and the matching successful command/done; the draft survived |
| New command with trailing spaces, one empty summary response | Same pending editing behavior; release produced a visible error card and matching error command/done; no committed summary; the draft survived |
| Select the new command from the slash menu | Same editing and true-completion checks, with one durable child summary |
| Original `/subagent-compact all` | Command name and argument reached the host unchanged; typing, deletion, and paste left the command text unchanged while pending; completion cleared it and produced a successful batch result and durable summary |

The evidence snapshots retain synthetic command IDs and summary provenance. Running snapshots are captured before releasing the response barrier. Result snapshots include the later completed request state. The screenshots show the actual running, success, and error cards.

The first legacy observation used Playwright's `isEditable()`, which returned true for this textbox despite `contenteditable=false`. The follow-up `legacy-edit-result.json` records the actual keyboard and clipboard operations and the DOM's `submitting` phase: all attempted edits were blocked. The original `editable` fields remain in the initial snapshots as raw probe output, not proof of user editability. The new command's checks used actual typing, deletion, and paste from the start.

## Scope

This proves the new command's composer behavior and real success/failure lifecycle in the bundled rc.5 Web pipeline. Full automated compatibility coverage remains rc.1/rc.2. It is not a full rc.5 regression run, native Electron-window acceptance, a real-model summary-quality evaluation, a published Git tag, or a daily installation update.

Public evidence excludes raw browser launch URLs, authentication tokens, complete session stores, model request bodies, and personal configuration. Machine paths in automated logs are redacted; assertions and totals are preserved.
