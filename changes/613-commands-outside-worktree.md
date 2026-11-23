---
section: security
---

- **Commands an agent runs in a folder outside the worktree now ask, even when they name no path.** Codex, OpenCode and ACP agents (Cursor, Gemini CLI) say which folder a command runs in. CodeDen judged a command's paths, but not that folder, so `git clean -fdx`, `git reset --hard`, `git checkout -- .`, `make clean`, `npm install` or `touch x` run in another repository ran at Auto and Full without asking. Such a command now asks, at Full too, unless it only reads (`git log`, `ls`, `git status`, also inside `bash -lc '…'` or `pwsh -Command …`). A folder in CodeDen's own home outside the session's own asks at every level, and so does input Codex types into a running terminal, whose shell may have moved since it started, unless it only reads. Commands in the worktree, its extra folders and the temp folder run as before.
