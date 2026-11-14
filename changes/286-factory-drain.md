---
section: added
---

- **Finish current work, then stop.** The factory's kill switch is now a choice. **Finish current work, then stop** (offered first) starts no new work: no new issues, builds or scout rounds. The work already in flight carries on to the end of its pipeline, with the usual checks, and is reviewed, rebased and merged as before. Once the last item merges, fails or needs you, the factory stops by itself, with one inbox notice: "Factory stopped after finishing N items". **Stop now** still stops everything at once.
  - While it drains, the header, the factory panel, the Factory view and the pixel scene (where the IN door is closed) show "Draining: N items in flight", with **Resume** to cancel it and **Stop now** to stop everything at once.
  - Queued items stay queued. Nothing is left half done to retry or rebase afterwards. Release the kill switch to start again.
  - An optional time limit (none by default, or 30 minutes up to 4 hours) falls back to Stop now if work is still in flight when it runs out.
  - A restart of CodeDen keeps draining, and the PM sees it in `factory_status` and its status digest. The daily digest says it too.
  - API: `POST /api/projects/:id/kill-switch` takes `mode` (`now`, the default, or `drain`) and `drainLimitMin`, and `FactoryStatus.drain` reports the drain. The global kill switch still only stops now.
