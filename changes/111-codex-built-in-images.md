---
section: fixed
---

- **Images Codex generates with its built-in tool now show in the chat, and no longer bloat the session history.** CodeDen used to write the whole image, base64-encoded (often 1-3 MB), into the session's history for every image a Codex session created, and the transcript showed only a "Generate image" step full of encoded text. The picture is now stored once as a session artifact and shown inline with Codex's revised prompt as its caption. The step keeps just the prompt and the saved file's path. A generation that fails (for example on Codex's image limit) shows as a failed step with the reason.
