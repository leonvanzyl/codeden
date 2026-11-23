---
section: fixed
---

- **A PM's session without a named provider starts only on one that is ready.** When the PM's `start_session` named no provider, it fell back to the project's default or the Settings default even when that provider wasn't installed or signed in, and the session then failed to start. It now takes the project's default, else the Settings default for agents (on `auto`, the first ready provider), only when the provider is loaded and ready; when none is, the call is refused with the loaded providers, the state of each and its fix, so the PM can name one that works.
- **The orchestrator can no longer set a project's default provider to one that doesn't exist.** `create_project` and `update_project` stored any provider id as the project's default. They now refuse an id the runner hasn't loaded and name the loaded providers.
