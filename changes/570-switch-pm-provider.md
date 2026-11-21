---
section: fixed
---

- **The orchestrator and project managers can be moved to another provider.** Their provider came from **Settings → Providers → Defaults per role** only when they were first started, so changing it later did nothing, and someone without the default provider (Claude Code not signed in, for example) had no way to use them: every turn failed and the model picker showed the other providers greyed out with "Start a new session to switch providers". Choosing another provider in that setting now retires the current orchestrator or PM conversation, and your next message starts a fresh one on the new provider. The picker in their chat says so on the greyed-out providers and has a **Change provider** link to the setting.
