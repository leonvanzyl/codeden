---
section: fixed
---

- **The factory no longer fails an agent that is waiting on its own background command.** A builder or reviewer that ended its turn to wait for an install, build or test run in the background, and replied to the factory's reminder that it was still waiting, was failed on the next tick (about a minute later) and stopped, throwing away the work that followed. The factory now waits until the agent has stayed idle for 10 minutes after its last turn before it fails the item (when the builder didn't report its reproduction or analysis, or opened no pull request) or the review (when the reviewer gave no verdict). A command that finishes wakes the agent, and the item carries on. The wait is the new `idleGraceMin` tuning setting. Builder and reviewer briefs now also ask agents to run installs, builds and tests in the foreground.
