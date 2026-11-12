---
section: fixed
---

- **The composer's `/` menu lists your commands and skills.** Typing `/` at the start of a message now shows what the session's agent can run: for Claude Code, its built-in commands (such as `/compact` and `/context`), your skills, plugin commands and your custom commands from `.claude/commands/` and `~/.claude/commands/`; for Codex, its skills. The list narrows as you type, names that start with what you typed come first, and picking one inserts `/<name> `. Before, the menu was always empty because the server never answered it.
