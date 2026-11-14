---
section: fixed
---

- **A busy factory no longer marks good pull requests stuck when GitHub slows it down.** GitHub's secondary rate limits (the ones a burst of merges, branch updates and comments can hit) were treated as GitHub refusing the merge, so after three of them the merge queue handed a perfectly good pull request to a person. CodeDen now recognises them as rate limits: the merge queue tries again on its next check without counting them against the pull request, and GitHub sync waits as long as GitHub asks (a minute when it doesn't say).
