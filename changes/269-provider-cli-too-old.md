---
section: fixed
---

- **The factory no longer picks a provider whose CLI is too old to run.** A Gemini CLI older than CodeDen supports now counts as unavailable, the same as one that isn't installed or signed in, so builders and the reviewer fallback skip it from the first try. If a session still can't open because the CLI is too old, the factory keeps new work off that provider and starts the reviewer elsewhere, without failing the review. Settings, the model pickers and the factory's Agents section say "Gemini CLI 0.36.0 is too old (needs 0.68.0+)" with the update command.
