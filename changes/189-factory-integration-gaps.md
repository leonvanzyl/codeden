---
section: fixed
---

- **Fixes to how the factory handles its pull requests.**
  - **An approval only covers what the reviewer checked.** Suppose the reviewer was still re-checking one conflict resolution when a newer resolution arrived. Approving the first one let the newer one merge without a check. Each re-check now covers only the commit it was asked about, and a PR merges only once its latest commit has an approved re-check.
  - **A failed rebuild no longer loses its pull request.** When a rebuild ended before its new PR was opened, the original PR vanished from the **Pull requests** card and the factory stopped watching it. Now it stays listed and the factory keeps watching it until a replacement exists. The item is marked stuck and comes to you, and merging or closing the PR on GitHub finishes it.
  - **Restarting CI respects Agents at once.** When CI never started on a PR, asking its author to push a new commit now waits for a free agent, like every other agent the factory starts.
  - **Protected areas count as stuck.** A PR escalated because it touches a protected area is now marked stuck, like the other cases that need you.
