---
section: fixed
---

- **Settings > GitHub no longer says the GitHub CLI is not installed while the setup checklist says it is signed in.** The GitHub token was read with whatever `gh` was on the server's PATH, which an app started from the Dock doesn't have, while the checklist also looked in Homebrew's folder. Both now look tools up the same way (PATH, then the tool's known install locations), and so do the server's other `gh` and `git` calls.
