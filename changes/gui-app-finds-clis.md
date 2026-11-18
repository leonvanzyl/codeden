---
section: fixed
---

- **CodeDen started from the macOS Dock or Finder (or a Linux desktop launcher) finds the CLIs your terminal finds.** Such an app gets the system's minimal PATH, so Codex installed with Bun, npm or nvm read as not installed in the setup checklist and `codeden doctor`, and agents, terminals and git ran without your PATH. The CLI, the desktop app's server and the runner now ask your login shell for its PATH at start-up (five seconds at most) and add it to their own; a re-check reads it again, so a tool installed meanwhile is found. The agent CLIs and `gh` are also looked for in the package managers' global folders (Bun, pnpm, Volta, npm's prefix, `~/.local/bin`, Homebrew) when the shell can't be read. `CODEDEN_LOGIN_SHELL=0` turns the shell read off.
