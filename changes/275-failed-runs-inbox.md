---
section: fixed
---

- **Failed runs no longer flood the inbox.** A factory reviewer or builder that can't start on its provider (a CLI too old, signed out, not installed) is restarted by the factory on another provider. Its failure is now recorded already settled and listed in the daily digest under **Failures it handled on its own**, instead of waiting on you. A session has one **Failed run** item: a later failure updates it with the latest error and an attempt count ("Failed 3 times") instead of adding another.
- **Failed runs settle on their own.** An item resolves itself, with a short note, once the session ran again, another session of the same work succeeded, a pull request of the work merged or closed, or the factory finished or dropped the work. Items left from earlier settle when CodeDen starts. **Dismiss all** next to **Failed runs** clears the rest.
- **Retry is honest.** While the session's provider can't run, **Retry** is off and the item says why and how to fix it ("Codex is not signed in. Fix it with `codex login`"), with **Continue on another provider** to hand the work off. A retry that fails says "Retry failed" with the reason, not "Couldn't update the item".
