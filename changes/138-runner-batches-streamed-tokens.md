---
section: fixed
---

- **Streaming answers cost far less.** The runner now sends an agent's streamed text in batches of up to 50 ms instead of one event per token, so a long answer is a handful of events in the session history, not thousands. Acknowledged events leave the runner's journal in occasional cleanups instead of a full rewrite of the journal after every event, which kept the runner busy (and its agents and terminals waiting) while agents streamed. Events the app hasn't stored yet are still kept and replayed after a restart, as before.
