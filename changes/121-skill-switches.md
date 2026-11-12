---
section: added
---

- **Switch skills on and off from the Agents page.** Each skill on the **Skills** tab now has a switch, so you can stop an agent seeing a skill without deleting or moving its folder. CodeDen writes the provider's own setting: `skillOverrides` in Claude Code's settings files and `[[skills.config]]` in `~/.codex/config.toml`. You see the diff before it's saved, and a backup is taken first.
  - If a settings file already turns the skill off or on, CodeDen edits that file. Otherwise it writes your user-level file, so the switch reaches every session, worktrees included. Codex project skills are matched by name, because their path is different in every worktree.
  - Claude Code's partial states show next to the skill as **name-only** or **user-only**.
  - **What's loaded** dims the skills that are off for the session and labels them **off**. The composer's `/` menu leaves them out.
