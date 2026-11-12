---
section: security
---

- **Agents can no longer read CodeDen's own tokens without asking.** Reading or changing the install token, the runner's lock file or the network access store in `~/.codeden` now asks at every permission level, Full included, and is refused for Read-only sessions, the orchestrator and PMs. The path can be written out or reached through `~`, `$CODEDEN_HOME`, a wildcard or the folder that holds the file, anywhere in a command. **Approve for session** covers these files only for the exact call you approved, in the same directory. Before, an agent at Auto could read the install token and use CodeDen's local API to approve its own requests. Codex still runs reads it considers safe, such as `cat`, inside its own sandbox without asking; see [Security](docs/security.md#permissions).
