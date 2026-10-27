# Validation record

Plugin version: **1.0.1**. Tested runtime: **DSH Desktop 0.12.1 / Harness 0.2.1-rc.2**. Recorded: **2026-10-27**.

This is a summary of the implementation review and local acceptance runs. Raw conversations, screenshots, machine configuration, and session logs remain outside this public repository.

## Automated checks

Run from the repository root with the matching DSH module tree available:

```sh
node --test --test-timeout=30000 test/unit.test.mjs test/integration.test.mjs
```

The reviewed release passes **26 tests: 25 unit tests and one integration test**.

The integration test composes real DSH runtime modules, a temporary JSONL session store, and a local fake Messages SSE endpoint. It verifies:

- A settled child is reclaimed; a later compaction request returns `not-resident`.
- A subsequent message restores the same child session as a new live Agent instance.
- A compaction request made while that child is running waits for idle, then invokes the real compaction engine.
- The measured history surface shrinks from **1,564 to 273 estimated tokens**, and compaction events reach persistence.
- The child answers a later message, and an unrelated parent is denied access during a live window.

The fake endpoint scripts the summary text. These tests validate runtime integration, cancellation, authorization, and persistence; they do not evaluate an external model's summary quality.

## Desktop acceptance

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

The public distribution preserves the reviewed runtime implementation. Its `index.js` SHA-256 is:

```text
534aff3a38bf5fdc1e0d5554b3b1a959aad510dcc55c73ee6970dc63db90d872
```

Distribution changes add repository metadata and public documentation. They do not change compaction behavior. Compatibility and summary quality on other runtime or model versions remain unverified.
