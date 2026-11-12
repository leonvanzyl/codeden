---
section: fixed
---

- **Removing a worktree on Linux and macOS leaves your own processes alone.** Archiving a session (or the factory or the inactivity sweep removing a worktree) no longer ends a shell, dev server or test watcher you started in the worktree yourself when CodeDen can't see where it came from, for example an SSH login on a machine that hides other users' processes, or a `docker exec` shell or editor terminal when CodeDen runs in a dev container. Only what CodeDen's agents and terminals started there is ended; ending everything that runs in the folder is now limited to Windows, where those processes keep it from being removed. On macOS, editors installed under a path with spaces (such as Visual Studio Code) are also recognised as your apps.
