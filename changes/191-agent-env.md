---
section: fixed
---

- **Agents no longer inherit CodeDen's own settings.** Agents of every provider, terminals and setup scripts used to get CodeDen's internal `CODEDEN_*` variables, such as its data folder (`CODEDEN_HOME`) and, in the desktop app, its installer (`CODEDEN_DEPS_INSTALLER`). A project that reads them, CodeDen's own repository included, then pointed at your real CodeDen data folder and the npm registry from inside a session. These variables now stay inside CodeDen, and the rest of your environment is passed through as before.
