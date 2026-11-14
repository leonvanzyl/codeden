---
section: security
---

- **Agents ask before reading your agent CLIs' logins, at every permission level.** Reading, copying, moving, uploading, archiving or searching Claude Code's `.credentials.json` and `~/.claude.json`, Codex's `~/.codex/auth.json`, Gemini CLI's `oauth_creds.json` and `google_accounts.json`, OpenCode's `auth.json` and database, Cursor CLI's `auth.json` or the GitHub CLI's `hosts.yml` (or the folder holding one) now asks under Auto and Full, also when `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or the XDG folders move them. `attach_evidence` and `share_to_chat` refuse them. Before, an agent could read them at Auto without asking. Reading a CLI's settings (`config.toml`, `settings.json`) still doesn't ask.
- **Uploading a secrets file asks.** `curl -F file=@.env`, `--data-binary @.env` and the like count as reading it.
