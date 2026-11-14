---
section: fixed
---

- **Codex sessions keep working on a busy machine.** When archiving a Codex conversation after a turn took longer than CodeDen waits for it but still went through, every later turn in that session failed with "thread not found" until the session was reopened. CodeDen now reopens the conversation before each turn whatever the archive answered, and if Codex still reports the thread missing, it reopens it and tries the turn once more.
- **Restart recovery no longer waits for the Codex app clean-up.** After CodeDen restarts, cut-off sessions are resumed without waiting for it to archive the conversations a crash left in the Codex app, and a runner that reconnects during that clean-up has its own sessions resumed too.
