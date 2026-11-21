---
section: fixed
---

- **Terminals on macOS find `npm`, `node` and Homebrew tools.** On macOS a terminal's shell (zsh, bash, sh, ksh, dash, fish, tcsh or csh) now starts as a login shell, as in the system's Terminal, so the PATH that `~/.zprofile` or `~/.bash_profile` sets up (Homebrew, nvm and the like) is there. Before, a terminal in the desktop app started from the Dock had the system's bare PATH plus what `~/.zshrc` adds, and answered `command not found: npx`. A login bash reads `~/.bash_profile` (or `~/.bash_login`, or `~/.profile`) instead of `~/.bashrc`; other shells start as before.
