# Watcher timeout evidence

This folder records the real alpha.1 timeout and the monitor repair.
`original-ci-*.json` are unchanged artifacts from run 44985777841 at cdbbef4.
`*-red.log` preserve intentional negative controls; `watcher-green.log` and
`stock-rc1.log` contain the passing checks. `alpha1-diagnostic*` use the exact
17a4aa7 source, isolated temporary stores, and public alpha.1 dependencies.
The diagnostic is deliberately bounded; it is not a passing compatibility run.
No credentials, daily profiles, real sessions, or dependency caches belong here.
Raw logs retain their original whitespace and are excluded from source/doc
whitespace claims. `acceptance.md` explains provenance and remaining limits.
