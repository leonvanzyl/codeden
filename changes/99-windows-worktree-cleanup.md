---
section: fixed
---

- **Finished sessions' worktrees are removed on Windows.** Archiving a session (and a factory item finishing) no longer leaves its worktree behind with "Couldn't remove the worktree: The worktree is in use". Before removing a worktree, CodeDen now ends everything still running in it, including dev servers an agent started before CodeDen restarted or updated, and processes that only have the folder as their working directory. Your own editors, terminals and file managers, and what runs in them, are left alone, also when they were opened from a shell in the worktree. A removal that fails is retried twice before it reaches the inbox, and the inbox item names what still runs in the folder. Worktrees an earlier version moved to the trash but couldn't delete are cleaned up too.
