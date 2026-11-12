---
section: fixed
---

- **OpenCode replies no longer go missing after a late steer or a queued prompt.** When OpenCode started work on its own after a turn had ended (for example a steer that arrived after the agent's last step, or a prompt queued behind **Stop**), CodeDen dropped everything the agent did in that run: no reply, no reasoning, no tool calls, and the session status no longer matched what the agent was doing. That run now opens a turn of its own, and its reply shows up in the transcript.
