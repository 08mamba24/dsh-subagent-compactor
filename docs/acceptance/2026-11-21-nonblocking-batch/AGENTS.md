# Acceptance evidence roles

- `acceptance.md`: human-readable scope, method, results, and limits.
- `evidence.json`: version/source provenance, automated totals, and evidence hashes.
- `*-suite.log`: path-redacted final automated regression output.
- `red-focused.log`: negative control against the previous product source.
- `initial-parent-log-assertion-failure.log`: retained test-development failure; not a product regression result.
- `ui/`: synthetic Web interaction snapshots, screenshots, and the journey module used by the isolated local driver. Keep running snapshots separate from later result snapshots.

Do not add raw launch logs, authentication tokens, complete session stores, personal profiles, or real conversations. New verification belongs in a dated record; do not replace these historical results with later outcomes.
