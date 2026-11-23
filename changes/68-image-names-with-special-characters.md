---
section: fixed
---

- **Attached images with a special character in their name show again.** An image or shared file whose name held a character outside Latin-1, or a control character other than a tab or a line break, showed as a broken image in the chat, the queue and the image viewer, and couldn't be downloaded, although the agent received it. That covers every macOS screenshot (its name has a narrow no-break space before "AM"/"PM") and names with CJK characters or emoji, on the computer itself and over network access alike; plain names and names with Western European accents were not affected. The server now sends such a name in a form every browser accepts, and downloads keep the full name (#68).
