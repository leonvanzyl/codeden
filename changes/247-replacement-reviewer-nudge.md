---
section: fixed
---

- **A factory reviewer that takes over from another one is reminded to submit its verdict before its review can fail.** When a reviewer session died, was stopped or hit a provider problem (a usage limit, sign-in) after it had been reminded, the fresh reviewer that replaced it was never reminded itself. If it ended a turn without a verdict, the review failed after the grace period and cost the pull request a revise round. Each new reviewer now gets its own reminder first, and its review fails only if it ends without a verdict again.
