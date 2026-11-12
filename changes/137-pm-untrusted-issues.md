---
section: security
---

- **The PM can't start work on a stranger's issue unless you asked.** A triage run, a GitHub or factory notice, a wake-up or another agent's message can start a PM turn, and in that turn the PM reads issues anyone can write. In those turns CodeDen now refuses `start_session` for an issue whose author isn't trusted (not one of the project's trusted authors, not the account CodeDen uses on GitHub, no write access to the repository) and refuses `factory_admit_issue` outright. The PM puts the issue in your inbox instead ("Should I take this on?"). When you ask the PM in your own message, or ask the orchestrator and it passes your request on, the PM can still start work on any issue and let one into the factory.
