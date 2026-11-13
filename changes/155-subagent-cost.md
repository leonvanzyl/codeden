---
section: added
---

- **Subagent cards show what each subagent cost.** A finished subagent's card now leads with its cost, for example `≈ $0.42 · 48.2k tokens · 23 tool calls · 1m 12s`, so you can tell which delegated work spent the money in an expensive turn. Hover the figures to see the cost per model, with the input, output, cache-read and cache-write tokens behind it, which matters when a subagent runs on a different model from its parent. Costs are priced like the session's: from your price table (edits apply at once), marked `≈` when estimated, and shown as API-equivalent for subscription logins. Works for Claude Code subagents, whose final token counts are read from the subagent's own transcript, and Codex sub-agents. The cost is part of the turn's cost, so it is never added to totals, reports or budgets.
