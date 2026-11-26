---
section: fixed
---

- **A message the runner took too long to confirm no longer stalls the queue.** When the runner answered a message late but its turn had already started, CodeDen treated the message as undelivered: the session showed Idle under a running turn, the message went back in the queue and was sent again later, and delivery paused. It now counts as delivered, the session stays Working, and the next message goes when that turn ends.
- **Repeated requests no longer pile up while a session is busy.** A message from a PM, the orchestrator, an automation or CodeDen that is already waiting word for word from the same sender is queued once. Your own messages are always queued.
- **The queued-messages tray says how long the next message has waited**, in the waiting colour after 10 minutes, so a stuck queue stands out.
