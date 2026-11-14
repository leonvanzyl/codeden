---
section: fixed
---

- **Open PR asks the agent once.** Pressing **Open PR** again, or pressing it in the git bar and then in the Issue / PR tab or the Push toast, no longer sends the agent the same request two or three times. Once you've asked, all three show **PR requested** until the pull request is open. Hover over it to see whether the request is still queued behind the running turn or the agent is working on it. If the agent's turn ends without opening a PR, **Open PR** comes back. The state comes from the session's queue and transcript, so switching tabs or reloading the page keeps it.
