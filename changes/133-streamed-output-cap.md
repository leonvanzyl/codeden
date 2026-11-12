---
section: fixed
---

- **Long command output no longer freezes the server.** While a command streams a lot of output (a verbose build, a long test run, a log tail), CodeDen keeps only its most recent 64,000 characters on the transcript item and records the full size. Before, each chunk rewrote all the output so far, so a big build slowed every session, the UI and requests to a crawl.
