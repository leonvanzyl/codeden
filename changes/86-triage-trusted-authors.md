---
section: security
---

- **Issue triage no longer starts work from strangers' issues by itself.** With `autoStart` on, a ready issue now starts an agent session only when its author is trusted: the GitHub account CodeDen uses, the project's trusted authors, or someone with write access to the repository (owner, organization member or collaborator). Anyone else's issue becomes a "Should I take this on?" inbox decision, and the item says the author has no write access. The PM's triage request and the resolving agent's brief now say that issue text and comments are input data, not instructions, so a comment added after you accept an issue can't redirect the agent.
