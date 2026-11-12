---
section: added
---

- **See a session's hooks in What's loaded.** For Claude Code sessions, **Details → What's loaded** now has a **Hooks** list. It shows the hooks that apply to the session's own folder: those in `~/.claude/settings.json`, in the working folder's `.claude/settings.json` (for a worktree session, the worktree's copy), and in `.claude/settings.local.json`. Each hook shows its event, matcher, what it runs and its scope; hover for its file. If `disableAllHooks` turns hooks off for the session, the list names the file that did it. **Edit hooks** opens the Hooks tab. When a command is refused, or something runs after every edit, the answer is one click away.
