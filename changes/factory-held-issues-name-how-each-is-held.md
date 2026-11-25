---
section: fixed
---

- **The factory's held list shows every issue the `factory:hold` label holds.** Intake refuses any open issue carrying `factory:hold`, but the Factory view's **Held** list left out an issue the loop had never taken in, such as one opened before the factory was switched on and never labelled `codeden-factory`. It looked like nothing was holding it while the loop said it was skipped for its hold, so a hold put on the issue by hand on GitHub was invisible. The list now covers every labelled open issue with no item, and each entry says how it is held: `recorded` when CodeDen made the hold (with its reason) or `label` when only the label is on the issue. Nothing about what the loop does with held issues changes: it still starts none of them, and removing the label still releases them on the next check.
