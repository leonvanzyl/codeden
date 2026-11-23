---
section: fixed
---

- **A runner replaced by a newer one no longer touches what is now the new runner's.** It used to keep saving the event journal while it shut down, when a server was still connected to it or a save was already due, and it let its sessions finish closing and write checkpoints in worktrees the new runner may be using. It now stops writing at once, closes its connections and ends its agents straight away. A runner that is closing also writes nothing more to the journal once another runner has taken over. On Windows, stopping a runner that stopped answering no longer reaches processes that only had a parent with a reused process id.
