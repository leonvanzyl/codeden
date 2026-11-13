---
section: changed
---

- **The server can drive several runners at once.** Every runner the server talks to is now recorded, with where it runs, its state and when it was last seen, and each session's commands, terminals and browser go to the runner that hosts it. With only the local runner nothing changes: it is registered as the home runner, and the status bar still shows it. This is the groundwork for running agents in sandboxes such as Docker containers or Upstash Boxes. A session whose own runner is gone now says which runner it lost instead of trying the local one.
