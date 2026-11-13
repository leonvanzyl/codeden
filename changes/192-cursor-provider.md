---
section: added
---

- **Cursor as a provider.** Sessions can run on the Cursor CLI with your own Cursor login and the models your plan includes. CodeDen drives the CLI's Agent Client Protocol server (`agent acp`), so transcripts, approvals at every permission level, plan mode, questions, todos, interrupt and resume after a restart work as they do for the other providers. Setup and `codeden doctor` detect the CLI, offer **Sign in** (`agent login`), and ask for `agent update` when the installed CLI has no ACP server. Subagents and Cursor's image generation are not wired up yet. Check your Cursor plan's terms before using it for unattended work such as the software factory.
