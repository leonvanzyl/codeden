---
section: added
---

- **Triage decisions close when their issue does.** A "Should I take this on?" item used to stay in the inbox after its issue was closed on GitHub. It now resolves on its own at the next sync, with a note such as "Issue #12 was closed as completed", and stays under **Recently resolved**; decisions whose issue was closed while CodeDen wasn't following resolve when it starts. Reopening the issue doesn't bring the item back: the next triage run asks again.
- **The project manager can tidy its project's inbox.** `list_inbox_items` lists every open item of the project, and `resolve_inbox_item` resolves a stale triage decision or a message that only informs, with a reason. Approvals, questions, messages that ask you to act and other projects' items always stay with you. A PM-resolved item shows "PM: <reason>" with **Restore** to put it back.
