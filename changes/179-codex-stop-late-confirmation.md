---
section: fixed
---

- **Stop also stops a Codex sub-agent that starts late, when Codex is slow to confirm.** If Codex confirmed the stop after CodeDen had already closed the turn, an agent that was just being spawned could start and keep running. It is now stopped as well, and its card stays cancelled.
