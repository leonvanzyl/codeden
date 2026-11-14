---
section: fixed
---

- **An MCP server's form no longer turns a typo into a refusal.** Number fields on a Codex MCP form are checked as you type, with a note saying what fits, and common ways of writing numbers are understood ("1,000" is 1000). An answer that still doesn't fit is sent back to you with what the field takes, and the form stays open, instead of the server quietly getting a decline while the card showed your answer. A form you dismissed or declined now says so in the transcript instead of looking answered.
- **The project manager no longer fills in MCP servers' forms.** Like approvals, an MCP server's form stays with you: `answer_question` refuses it instead of copying the PM's sentence into every field, and the PM's update says the form is waiting for you.
