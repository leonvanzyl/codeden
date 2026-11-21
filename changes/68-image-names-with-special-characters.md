---
section: fixed
---

- **Attached images with a special character in their name show again.** An image or shared file whose name held anything beyond plain Latin letters showed as a broken image in the chat, the queue and the image viewer, and couldn't be downloaded, although the agent received it. That covers every macOS screenshot (its name has a narrow no-break space before "AM"/"PM") and names with CJK characters or emoji, on the computer itself and over network access alike. The server now sends such a name in a form every browser accepts, and downloads keep the full name (#68).
