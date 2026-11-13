---
section: security
---

- **Evidence can no longer publish secrets.** `attach_evidence` now refuses secrets files (`.env`, `.npmrc`, SSH keys, `*.pem`, ...) and CodeDen's own credential files, wherever they are and under any name: renamed, reached through a symlink, or saved as an artifact. `share_to_chat` refuses them too, so a secret can't be staged as an artifact and attached by id. Before, an agent could publish its worktree's `.env` to the repository's `codeden/evidence` branch in one tool call, with no approval at any level. `.env.example` and other templates still attach. See [Security → Files](docs/security.md#files).
