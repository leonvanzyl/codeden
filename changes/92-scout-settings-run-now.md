---
section: added
---

- **Run scout now, and a backlog threshold for the scout.** A dark factory's panel has a **Run scout now** button that starts a scout round right away, without waiting for the schedule or for the queue to run low. While it can't (a round is running, no agent is free, the loop is paused or a kill switch is on) it's disabled and its tooltip says why. The scout's settings add **Review when fewer than**: the scout starts a scheduled round only when fewer issues than this wait, and 0 turns scheduled rounds off.
- **More factory settings.** The merge checks settings add **Revise rounds** (how many times a builder may revise before the item fails) and **Watch main CI (minutes)** (how long CI on the default branch is watched after an automatic merge), each with a short explanation.
