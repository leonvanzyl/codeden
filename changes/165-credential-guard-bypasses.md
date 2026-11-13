---
section: security
---

- **Three more ways around the guard on CodeDen's own tokens are closed.** A search with its options packed together (`grep -ne. ~/.codeden/install-token`, `grep -fFILE …`, `rg -e. ~`), a PowerShell list of paths (`Get-Content $env:CODEDEN_HOME\install-token,…`) and a CodeDen data folder whose name has `[`, `*` or `?` in it (`CodeDen [dev]`) no longer slip past the check. Before, these read the install token, the runner's lock file or the network access store without asking, at any permission level, and a bracketed data folder switched the guard off even for plain reads and writes. They now ask at every level and are refused for Read-only sessions, the orchestrator and PMs.
