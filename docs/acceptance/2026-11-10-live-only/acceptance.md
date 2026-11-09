# Live-only 1.2.0 acceptance — 2026-11-10

The stock Harness 0.2.2-rc.1 runtime compacted both live direct children through one `/subagent-compact all` command entered in the bundled Web UI. Both summaries were read back from disk, and both original child session IDs continued with the committed checkpoint in subsequent HTTP requests.

- Runtime: the installed application's ASAR `runProfile`, bundled Electron Node 24.21.0, standard preset and Web UI; fresh Playwright Chromium context.
- Plugin: 1.2.0; the runtime entry SHA256 is recorded in [evidence.json](evidence.json).
- Command: user-source `cmd-d700eb25-2`, run seq 8, successful completion seq 12. Both child summaries are seq 20 and reference that same command ID.
- Result: 2 compacted, 0 skipped, 0 failed; each child replaced 3 history items. Later requests for both children contain the committed checkpoint.
- Browser: zero page errors.
- Regression: the four tracked suites passed 46/46 on an isolated, unmodified installed 0.2.2-rc.1 module tree with Node 24.18.0.

[Batch command result](01-batch-command.png) · [Both children continuing](02-both-continuations.png)

The model endpoint was a loopback synthetic Messages SSE server. All sessions and content were synthetic and stored in fresh test directories. No external models, ordinary profiles or ordinary session data were used. The test service and browser were stopped afterward.

This proves the bundled Web pipeline and checkpoint mechanism. It does not prove native Electron-window interaction, the code version currently cached by an existing ordinary Desktop process, real-model summary quality, cold compaction or persistent batch receipt/report APIs. Raw session/request/profile records are intentionally excluded from this public source distribution.
