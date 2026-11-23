---
section: fixed
---

- **A project's Permissions say which sessions they don't reach.** A project's permission level is what its new sessions start with, so changing it left running sessions asking as before, with nothing saying why (#568). The project's Settings tab now names the open sessions that keep another level, with links, and says where to change a session's own (its Permissions picker, which applies while it runs). The orchestrator's `update_project` says the same in its result. The docs explain where a session's level comes from, that Supervised asks about every command (reads included), and that the project's autonomy mode doesn't change which actions ask.
