---
section: security
---

- **Evidence checks the name a file is published under.** `attach_evidence` cleans up file names before publishing them, so `-id_rsa`, `notes.p!em` and `credentials.js!on` went out as `id_rsa`, `notes.pem` and `credentials.json`, past the secrets check. It and `share_to_chat` now also check every name in its published form, and refuse those files with `secret_file`, whether they are attached by path, renamed, or saved as an artifact and attached by id. Ordinary files with odd names, `.env.example` and screenshots still attach. See [Security → Files](docs/security.md#files).
