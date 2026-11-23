---
section: fixed
---

- **OpenCode sessions get their `/` commands and skills.** With OpenCode as the provider, typing `/` showed nothing, and `/review` or `/my-skill` went to the model as plain text. The `/` menu now lists your OpenCode custom commands (`.opencode/commands/`, `~/.config/opencode/commands/` and the commands in your OpenCode config, nested ones as `team/review`) and your skills (`~/.config/opencode/skills`, `~/.agents/skills`, `~/.claude/skills` and the project's `.opencode/skills`, `.agents/skills` and `.claude/skills`), already in the New session draft. Picking a command runs it in OpenCode, so its template expands with the rest of the line as arguments, and picking a skill loads it with your message. A command OpenCode can't run ends the turn with its reason instead of hanging. Any other text starting with `/` is still sent as typed.
