---
section: changed
---

- **Toasts only for what needs you.** Every inbox item now has a category (needs you, failures, factory activity, automations), and **Settings → Notifications → Notify me about** chooses which ones raise a toast and a browser or system notification. Factory activity (its decisions, the PRs it reviews and merges, its own sessions' failures, the digest) is off by default, so a busy dark factory no longer floods the screen; it all still lands in the inbox and the daily digest. Approvals, questions, PRs a person has to merge, flagged decisions, a paused loop and regressions still notify you.
- **Bursts become one toast, and Open goes to the thing.** Several updates within a few seconds share one toast ("4 updates from the factory · Open inbox"), at most three toasts show at once, and a failed session raises one toast instead of two. Each toast says what happened in one line, and **Open** goes to the failed session or to the item in the inbox, scrolled into view and highlighted, instead of the top of the inbox. System notifications in the desktop app follow suit: a burst is one notification that updates in place, and clicking it opens the group.
