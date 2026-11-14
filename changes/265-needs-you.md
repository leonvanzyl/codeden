---
section: fixed
---

- **The Factory view's "Needs you" lists only what waits on you, and says what to do.** Its cards were failed items that needed nothing (their issues already closed), while the header said "0 need you".
  - When an item's issue is closed on GitHub and the item failed without a pull request of its own, it settles by itself: **merged** ("Resolved by #n") when a merged pull request that links the issue closed it, otherwise **rejected** with how the issue was closed (a duplicate, not planned, completed).
  - One definition of "needs you" counts the lane, the header, the pixel scene and the daily digest's "Waiting on you", so they always agree. A failure the factory puts back by itself (a session that died, CI that never started) stays in its stage instead.
  - Every card says what's needed and has the button for it: **Review and merge PR #n** (escalations, and pull requests the factory doesn't merge itself), **Retry** for work that stopped with its pull request open, **Retry** or **Dismiss** for work that stopped without one, and **Answer** for an agent's question. Pull requests waiting for you and stuck ones now wait in the lane rather than in the merge queue, and an agent's question moves there from its stage. The card's side sheet has the same buttons.
  - **Dismiss** marks the item rejected with the reason (`POST /api/projects/:id/factory/items/:itemId/dismiss`).
