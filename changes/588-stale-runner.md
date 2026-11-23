---
section: fixed
---

- **A runner left over from an earlier start no longer keeps working beside the new one.** After the app was quit and reopened, a runner that had stopped answering could keep running for hours: it started agent turns in the same worktrees as the new runner's sessions and held Codex threads, so resuming them failed with "Codex thread … is still open in another process". A new runner now stops a runner that holds the lock but doesn't answer, a runner replaced by another shuts itself down with its agents within seconds, and a runner always exits on SIGTERM, even when an agent never finishes closing.
