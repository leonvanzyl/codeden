---
section: fixed
---

- **CodeDen stays responsive while several agents stream long replies.** The server now stores the runner's events that arrive together in one go, joining streamed text for the same message, instead of rewriting a growing message once per streamed chunk. Long replies across several sessions no longer stall the app for seconds.
