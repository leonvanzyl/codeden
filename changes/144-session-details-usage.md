---
section: fixed
---

- **Session details no longer shows made-up usage.** The Context window section shows only what the provider reported: a figure it hasn't reported reads "—", and the bar appears once the context size is known. The cost comes from the usage ledger, like the session header: estimates are marked "≈", subscription logins see "API-equivalent", and a session with no turns says "No usage yet". Before, any missing figure fell back to sample values, so every Codex session claimed "$1.84 this session" and a new session showed 68k of 200k tokens used.
- **A model with no price says "Not priced" instead of "$0.00".** When the provider reports no cost and the price table has no price for the model, Session details, the session header and the turn footer now say so rather than showing a zero cost.
