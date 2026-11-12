---
section: fixed
---

- **An idle factory no longer fills the database or keeps the factory panel busy.** A factory loop check that finds nothing to do now saves nothing. Before, every check (every 30 seconds, and whenever a factory session changed) stored a full copy of the loop, adding thousands of records per project per day, and made every open factory panel reload. The panel now refreshes every 30 seconds only while work is in flight, every 5 minutes while the factory is idle, and at once whenever the factory changes; its "last check" is as of that refresh.
