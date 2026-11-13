---
section: security
---

- **Evidence checks the name a file is published under.** `attach_evidence` cleans up file names before publishing them, so `-id_rsa`, `notes.p!em`, `credentials.js!on` and `service/account.json` went out as `id_rsa`, `notes.pem`, `credentials.json` and `service-account.json`, past the secrets check. It and `share_to_chat` now also check every name in its published form, and refuse those files with `secret_file`, whether they are attached by path, renamed, or saved as an artifact and attached by id. `attach_evidence` also checks the final names, after `-2` tells repeated names apart. Ordinary files with odd names, `.env.example` and screenshots still attach. See [Security → Files](docs/security.md#files).
