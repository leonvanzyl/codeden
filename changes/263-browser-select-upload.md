---
section: added
---

- **Agents can choose options in select menus and upload files in the session browser.** A native `<select>` menu opens in a popup that neither clicks nor screenshots reach, and clicking an upload button opened a file chooser nothing could answer, so agents couldn't test "pick a country" or "upload a CSV" flows. The new `browser_select` tool picks options by the label the page shows (or by value), several on a multiple select, and the page gets its usual change events. The new `browser_upload` tool sets files on a file input, or clicks an upload button or drop zone and answers the file chooser it opens. Both work in the runner's browser and in the desktop app's native views. Uploads only take files from the session's working folder, the temp folder or its own artifacts, and never secrets files such as `.env` or keys, since a page can send what it is given anywhere.
