---
section: changed
---

- **A PM sees which providers it can start a session on.** The `provider` parameter of the PM's `start_session` tool was a free-form id with nothing to choose from, so a PM found the valid ones by starting sessions and reading the failures. Its description now lists the providers that are loaded and whether each is ready, with the reason and the fix when one isn't (for example `gemini` (Gemini CLI): not installed, fix: `npm install -g @google/gemini-cli`). The orchestrator's `create_project` and `update_project` list them the same way for `defaultProvider`. `start_session` still refuses a provider id that isn't loaded, and the refusal now names the loaded ones.
