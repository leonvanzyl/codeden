---
section: security
---

- **The files panel never opens CodeDen's own credential files.** If a session's folder contains CodeDen's data folder (a project at your home folder, say), the install token, the runner lock and the `.invalid-*` copies kept of damaged ones are refused, as `share_to_chat` and `attach_evidence` already did.
