---
section: changed
---

- **The factory finishes open work before it starts more.** A free agent now goes to a review first (of a pull request whose CI passed), then to a rebase or revise round, then to a review of a pull request whose CI is still running, then to a build (one carrying on after a failure before a new one from the queue), and to the scout last. Work in progress is never interrupted. Revise rounds and rebase requests now wait for a free agent instead of going past **Agents at once**.
- **PRs open at most.** A new work-in-progress limit in the factory settings (`maxOpenPrs`, by default the same as **Agents at once**). With that many factory pull requests open, waiting for you to merge them included, no new build starts from the queue and the dark factory's scout files nothing until one merges or closes. A fix for failing checks on the default branch still starts. The factory panel and the Factory view show **Finishing open work (2 of 2 PRs open)** while the limit holds work back. With auto-merge off, raise it if you merge in batches.
- **Queued work that touches the same files as an open pull request waits its turn.** When an issue names files an open factory pull request changes, other queued work starts first ("Deferred: likely overlaps open PR #12"); it still starts when nothing else is waiting.
