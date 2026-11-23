---
section: security
---

- **The runner's log no longer shows the command lines of processes it ends.** When it ended processes left running in a worktree, the log line held the first 80 characters of each one's command line, which can carry a token or password. It now names each process by its program's file name and pid only (`node.exe (1234)`), as the "still running there" message already did.
