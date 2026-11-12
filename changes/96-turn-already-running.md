---
section: fixed
---

- **A message that arrives during a running turn no longer fails the session.** When two messages reached a session at the same moment (a factory revise or nudge, a PM message, a queued message going out as the turn ended), the second could be sent as a new turn and fail with "A turn is already running", marking the session failed while its agent kept working. Messages now wait in the session's queue behind the turn on its way and go out, in order, when it ends. If the agent turns out to be mid-turn anyway, the message is queued instead of failing.
- **The software factory no longer gives up on a builder over this error.** A builder the error marked failed is told to carry on instead of having its item failed, and items it already failed (such as one whose builder was running its final tests) go back to building on the next tick, with their builder and its worktree brought back.
