---
section: added
---

- **Gemini CLI as a provider.** Sessions can run on Gemini CLI (0.68 or newer) with the login you chose in it: Google, a Gemini API key or Vertex AI. CodeDen drives its Agent Client Protocol server (`gemini --acp`) through the same client as Cursor, so transcripts, approvals at every permission level (CodeDen's own tools recognised by the MCP server Gemini CLI names), plan mode with a **Plan ready** card for its plan, token usage, interrupt and resume after a restart work as they do for the other providers. Sessions run in Gemini CLI's `default` mode even when yours defaults to YOLO, and CodeDen never signs it in itself, so your chosen login method is never changed. Setup and `codeden doctor` detect the CLI, read its login from its own settings without touching credentials, and offer **Sign in** (`gemini`). Questions, its subagents and steering are not wired up yet. Check your plan's terms before using it for unattended work such as the software factory.
