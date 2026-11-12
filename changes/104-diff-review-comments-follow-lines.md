---
section: fixed
---

- **Diff review comments stay on the lines you commented on.** When the diff refreshes (a new checkpoint, a commit or a Restore), each comment now moves to wherever the lines it quotes are in the new diff. Before, it stayed on the old line number and could end up under a different line. A comment whose lines are no longer in the diff now appears under **Outdated** at the top of the Diff panel, with the lines it quotes. Before, it disappeared from view but was still sent. You can edit or delete each outdated comment, and it's still sent with the lines as they were.
- **An unsaved comment in another view no longer locks Send.** If a comment you haven't saved is open in another view, or in a diff that is still loading or didn't load, the review bar now tells you, even before you've saved any comment. **Show** switches to its view and scrolls to it, and **Cancel edit** drops it. You no longer have to discard every comment to send the review.
