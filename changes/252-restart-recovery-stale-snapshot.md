---
section: fixed
---

- **Resuming sessions after an upgrade or runner restart no longer breaks a session you resumed yourself.** CodeDen resumes the sessions a restart cut off one at a time. If you sent one of them a message or pressed Retry while it was still resuming the others (or a queued message reached it first), recovery still treated it as cut off: it closed the live turn and its approvals, tried to resume it a second time and could mark it failed. Recovery now asks the runner again what it hosts after each slow resume, and leaves alone any session that is running again or has a message on its way. A session that turns out to have a turn running is never marked failed.
