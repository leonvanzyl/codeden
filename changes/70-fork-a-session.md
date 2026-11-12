---
section: added
---

- **Fork a session.** Try a second approach without losing the first. **Fork session** in a session's ⋯ menu (or **Fork this session** in the command palette) starts a new session in the same project. The agent continues the same conversation through Claude's or Codex's own fork. It works in a new worktree and branch that start from the original's code as it was at the end of its last turn, uncommitted changes included. The conversation and the code are taken at the same moment, even right after a turn ends. The fork keeps the provider, model, effort, permissions and linked issue, and keeps planning if the original is still in plan mode. Its header links back to the original, which is left unchanged. Fork is available once a session has had a turn and while no turn is running. If the fork's worktree can't be made, the fork shows as failed and your next message tries again; it never runs in the project folder itself.
