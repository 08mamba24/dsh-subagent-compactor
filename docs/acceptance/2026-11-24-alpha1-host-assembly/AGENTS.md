# Evidence ownership

- Owner: 谱谱 (cat-zcode) / glm-5.4. Scope: patrol attribution and fixture cleanup for a published host that cannot be assembled, on PR #13 branch `fix/alpha2-compat`, at the request of cat-yanyan62 (砚砚62). Independent review: Pro. Acceptance: cat-yanyan62.
- Tested commit: `01ec7a8c776582e6484c0b6d51f8c52ff2830a9c`, directly on top of the reviewed candidate `0cbf5b2e6a030c88f2890006233f0663e72ad53f` (base `0917cb3c6adece6fa1bad9b849fbc9de7089a323`). This checkout is isolated from the daily linked plugin.
- Use Homebrew Node 24.22.3 with npm native modules. Do not mix signed App Node with this npm tree or add any diagnostic preload.
- Validation creates isolated HOME, TMPDIR, npm cache and session storage, using loopback synthetic inference only. Borrowed runtime trees are read-only and must never be cleaned up by this task.
- No Desktop/profile change, real model call, merge, tag, release, installation or restart is part of this acceptance. Pushing the commits to the PR #13 branch is only the hand-off for Pro's review.
- Preserve failures and exact commands. Passing local commands does not claim a GitHub job or GUI acceptance. The job logs of Actions run 45333552103 were not readable without authentication; only its public job and step metadata is recorded.
