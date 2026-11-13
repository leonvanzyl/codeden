---
section: fixed
---

- **A factory reviewer's broken local install no longer fails a pull request.** A reviewer whose own checkout couldn't run the tests (dependencies missing or corrupted after an interrupted install, timeouts under load) could request changes for that alone, which used up a revise round and could fail an item whose code was right and whose CI was green. Reviewers are now told that CI on the pull request's head is the authority for the full test suite, to reinstall a broken install non-interactively before testing, and never to request changes only because local checks couldn't run. A request for changes marked `blockers: "environment"` never reaches the author: the reviewer gets the CI result and reviews again. If its environment stops it a second time, the item fails as an infrastructure failure, which the factory recovers by itself without using a revise round, and the next reviewer works in a clean worktree on the PR's head.
