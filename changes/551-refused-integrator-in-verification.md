---
section: fixed
---

- **A factory pull request is no longer thrown away because its integrator's provider refused to start it.** When the integrator taking over a PR couldn't open (its provider signed out, a CLI too old) while the PR was in verification, it stayed in charge. Each conflict tick then sent it a bare "rebase" request on the same provider. After three of those the work was rebuilt from the default branch and the PR was closed. Now the refused integrator is let go and archived, and its provider is backed off once. In the same tick a fresh integrator, with its full brief, takes over on a provider that can take work. A refused start no longer counts as a request to rebase. An integrator the runner was too busy to answer is waited for a few minutes before it is replaced.
- **A CI-kick request no longer goes to a pull request that was merged or closed in the meantime.** Like rebase requests, it now checks the PR again right before it is sent.
- **A provider you signed in to is no longer held off factory work because of an older refusal.** The factory no longer backs a provider off for an integrator refusal that happened before you signed in or pressed Check now or Retry, or that it already acted on.
