---
section: fixed
---

- **A factory pull request closed on GitHub stops gating the merge checks.** When someone closed a factory pull request by hand without merging it, the Factory view's merge checks kept listing it, with the CI state of a pull request that no longer had a branch to merge (`pull request 10, ci: fail`) while the view's pull-request list was already empty. The two read the same projection differently: the pull-request list skips anything that isn't open, the merge checks only asked whether the item had a pull request at all. The merge checks now drop a pull request the code has decided on, merged or closed, the same way the pull-request list does, so both views agree. What the item had gathered stays where it was: the review verdict and the `tests` check are kept as evidence, and nothing reopens the pull request, re-runs CI, retries or rebuilds the work. The loop still settles the item on its own tick, exactly as before; only the report changes.
