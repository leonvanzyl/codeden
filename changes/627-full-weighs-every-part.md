---
section: security
---

- **Full weighs every part of a command.** A command with several parts is judged by its most severe part, not its first. At Full, a force push, a secrets-file read or a global install earlier in a command no longer lets a later write or delete outside the worktree run without asking (`git push --force && rm -rf ~/projects`), in any order and in every shell. `sudo` with a write outside the worktree asks at Full too, and so does a Codex patch that mixes files inside and outside it.
