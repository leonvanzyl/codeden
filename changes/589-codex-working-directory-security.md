---
section: security
---

- **Codex commands run from a folder outside the worktree now ask when they reach files there by a relative path.** CodeDen judged the relative paths in a command Codex asked to run as if it ran in the worktree, whatever folder Codex ran it in. So `rm -rf *`, `rm -rf build`, `find . -delete` or `echo x > notes.txt` run in another repository, or in CodeDen's own home, ran at Auto and Full without asking, and so did reading `config.json` in CodeDen's home and `git push --force-with-lease` in another repository (taken for a push of the session's own branch). They now ask, like the same command with absolute paths.
