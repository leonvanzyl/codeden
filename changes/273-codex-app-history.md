---
section: fixed
---

- **CodeDen's Codex sessions no longer fill the Codex app's recents.** The Codex apps list every Codex conversation on your machine as yours, so factory reviewers, builders, PMs and other CodeDen sessions crowded out your own chats. CodeDen now archives a session's Codex conversation whenever no turn of it is running, and unarchives it just before the next turn, a resume or a fork. Your own conversations are never touched.
- **Hide the ones from before.** **Settings → Providers → Provider apps → Hide CodeDen's sessions from the Codex app** lists the conversations CodeDen started that the Codex app still shows, found by CodeDen's own record of them rather than by their titles. It archives them once you confirm. They are archived, not deleted, and CodeDen can still resume them.
- **Claude Code sessions stay out of `/resume` when CodeDen runs from a Claude Code terminal.** CodeDen now always labels its Claude Code sessions as SDK sessions, which Claude Code's own `/resume` leaves out, instead of inheriting the terminal's label.
