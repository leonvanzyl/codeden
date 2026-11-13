---
section: fixed
---

- **After a reload, the transcript treats the right turn as the latest one.** A reloaded session listed its turns by their random ids instead of by when they started, so an older turn could count as the latest. The follow-up chips could then show an older turn's suggestions, and **Fork from here** and the latest turn's footer could appear on the wrong turn. Turns are now listed in the order they started, both when a session loads and as new turns arrive. The automation run status, auto-retry and the agent tools that attach to the current turn get the same order when two turns started at the same moment.
