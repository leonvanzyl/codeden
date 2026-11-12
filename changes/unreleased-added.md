---
section: added
---

- **Hooks on the Agents page.** A new **Hooks** tab lists the hooks in Claude Code's settings files (`~/.claude/settings.json`, and the project's `.claude/settings.json` and `.claude/settings.local.json`) with their scope, event, matcher, type, command and timeout. Add, edit, disable or delete one without leaving CodeDen. Every change shows a diff first and backs up the file, and only the `hooks` key is rewritten, so your other settings and formatting stay as they were. Claude Code can't switch off a single hook, so **Disable** moves it out of the file into CodeDen's data folder, and **Enable** puts it back. A file that sets `disableAllHooks` is flagged.
- **See what each subagent used.** When a subagent finishes, its card in the transcript shows the tokens it used, how many tool calls it made and how long it ran, e.g. `48.2k tokens · 23 tool calls · 1m 12s` (hover the figures for the exact numbers). A turn that cost a lot now shows which subagent spent it. Claude reports these figures for both foreground and background subagents; providers that don't report them show no figures.
