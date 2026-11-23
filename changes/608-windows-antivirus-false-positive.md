---
section: fixed
---

- **Antivirus no longer flags CodeDen as malware on Windows.** To find processes an agent left running in its worktree, the runner compiled C# code at runtime with PowerShell's `Add-Type` and read other processes' memory to learn their working folders. Antivirus heuristics flag that pattern as malware (for example `Gen:Variant:MSILHeracles`), blocked it, and the cleanup broke with it. CodeDen now never compiles code at runtime and never reads another process's memory. On Windows it finds leftovers by their executable and command line, as before, and, when a session stops, by the process tree: what was still running under the agent when it exited. A process that had already left the tree before the stop (started in the background from a shell that exited earlier) and doesn't name the worktree on its command line may now be missed. macOS and Linux are unchanged.
