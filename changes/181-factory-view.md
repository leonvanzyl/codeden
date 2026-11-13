---
section: added
---

- **Factory view.** A calm, full-screen view of a software or dark factory, made to stay open on a second screen. Open it with **Factory view** on the project page or the factory panel, from the command palette, or at `/projects/<id>/factory/view`.
  - The pipeline runs left to right as stages (Intake, Identify type, Building, Reviewing, Merge queue, Merged). Every item is a card showing what its agent is doing now, how long it has been in its step, its pull request's state and merge checks, and whether it's running, waiting, needs you or failed.
  - Cards move live. Clicking one shows its steps, pull request, checks and sessions in a side sheet.
  - Escalated and failed work gets its own **Needs you** lane (however old, while it still waits), stuck pull requests are marked in the merge queue, and the header counts what waits on you.
  - One row of figures shows spend against the budget, merges today, agents working, open PRs, failures and reverts today, and the median time from issue to merge over 7 days.
  - A quick PM chat sits beside it, and the header has the kill switch, **Check now** and **Run scout now**.
  - **Full screen** fills the screen (F11 in the desktop app). On tablets and phones the stages stack and the chat opens as a bottom sheet.
