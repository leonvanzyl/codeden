---
section: fixed
---

- **Stopped factory work with an open pull request recovers by itself.** A failed item whose pull request gets new commits after its last review (a fix pushed late, or conflicts resolved), with CI green, now goes back to a fresh review of that pull request on its own, with no new build. It merges on approve as usual, and a request for changes gets one more revise round. This happens once per new head, at most three times per item, and never while the factory is paused. The review runs in a clean worktree on the pull request's head, so it sees every commit.
- **Retry re-reviews the open pull request.** Retrying a stopped item whose pull request is still open sends that pull request straight back to review with fresh revise rounds. It no longer redoes the reproduction or analysis or opens a second pull request. **Rebuild** still starts over.
- **Retry is easy to find.** Failed items have a Retry button in the factory panel's Recent column, on the Factory view's "Needs you" cards and in the item sheet, not only on the item's page. The PM can retry items too, with the new `factory_retry_item` tool (`rereview` or `rebuild`). Work let in from an untrusted author is retried only at your request.
- **Honest labels.** A failed item's pull request says "Stopped after N revise rounds; needs a re-review (Retry)" instead of "waiting for a person to merge it". That wording is now used only for escalated work.
