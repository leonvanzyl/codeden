---
section: fixed
---

- **An expired sign-in on OpenCode no longer fails factory reviews over and over.** When OpenCode's model login had expired (for example an `openai/*` model while the OpenAI login was out of date), the turn failed with `Request failed: 401`. CodeDen counted that as an ordinary failure, so every replacement reviewer started on OpenCode again until the item failed. A 401 or 403 that OpenCode puts only in its error message now counts as a sign-in problem, as one in the status field already did. The reviewer then restarts on another available provider straight away, without using a revise round or one of the reviewer's restarts, and factory work stays off OpenCode for 30 minutes before it is tried again.
