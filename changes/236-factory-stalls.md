---
section: fixed
---

- **A pull request GitHub refuses to merge no longer blocks the merge queue.** When GitHub refuses to merge or update the pull request at the head of the queue (branch protection, a required check or review), the factory tries again on the next check, and after three refusals on the same commit it takes the pull request out of the queue as stuck, with what GitHub said, tells you once in the inbox and the PM, and merges the next one in line. A new commit on the pull request starts the count afresh.
- **A signed-out or rate-limited provider no longer freezes the factory.** Pull requests of work waiting for its provider to sign in again or for its usage limit to reset no longer count toward **PRs open at most**, so new work carries on with the other providers. The factory panel and the Factory view say which pull requests wait on what ("1 PR waits on Codex (not signed in) and doesn't count"), and the PM hears once when work has waited for five minutes.
- **PRs open at most is never overshot.** Builds that haven't opened their pull request yet now take room under the limit, so one check no longer starts a build for every free agent.
