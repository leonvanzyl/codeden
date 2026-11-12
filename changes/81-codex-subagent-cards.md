---
section: added
---

- **See what Codex sub-agents do.** When a Codex session spawns agents, each one gets a subagent card in the transcript with live status, like Claude's. Click it to open the agent's own thread: its messages, commands, file edits and plan. Its approvals show up in that thread and in the inbox. When it finishes, the card shows its last message and the tokens, tool calls and time it used, and its tokens count toward the session's usage. Calls between agents read as **Message agent: explorer**, **Wait for 2 agents** or **Close agent: explorer** instead of `Agent: spawnAgent`. **Stop** stops the session's sub-agents too: running ones, ones still working after its own turn ended, and ones it was still starting. Agents spawned before Codex restarted (for example after CodeDen restarts mid-run) aren't followed after the restart.
