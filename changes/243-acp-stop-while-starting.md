---
section: fixed
---

- **Stop works while Cursor or Gemini CLI is still starting.** If the agent CLI had to start again for a message (after it quit or crashed), pressing Stop before it was up did nothing: the message was sent anyway and the agent went to work. The turn now ends as stopped at once, the message is never sent, and the agent keeps starting so your next message is quick.
