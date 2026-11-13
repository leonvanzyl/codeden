---
section: fixed
---

- **"Are you sure?" dialogs in the session browser wait for an answer instead of closing at once.** A page's `alert`, `confirm` or `prompt` used to be dismissed the moment it opened, so a "Delete this item?" confirm returned Cancel whether you or the agent clicked the button, and the action silently didn't happen. Now the page pauses and the browser panel shows the dialog over it with **OK** and **Cancel** (and a text field for a prompt), on both the streamed browser and the desktop app's native one. Agents see the dialog in the result of the click that opened it and in `browser_snapshot`, and answer it with the new `browser_dialog` tool. A dialog nobody answers is dismissed after 2 minutes, and the panel says so. When you or an agent navigate away, a page's "Leave site?" no longer holds up the navigation.
