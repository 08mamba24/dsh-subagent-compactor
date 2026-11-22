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

`r2-red.log` runs seven new scenarios against d6fed785: six intended failures
and one healthy control. `r2-green.log` is the full 39-test pass at implementation
8574906. Its serial deadline probe scales one minute to 600ms in a copied CLI;
it is an orchestration regression, not Harness compatibility acceptance.
`r1-ci-summary.json` is the unchanged completed artifact from run 44989017838:
alpha.1 timed out with the real removed-export diagnostic, while rc.4/rc.5 passed.
