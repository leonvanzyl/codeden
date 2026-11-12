---
section: fixed
---

- **An idle factory no longer fills the database.** A factory loop check that finds nothing to do now saves nothing. Before, every check (every 30 seconds, and whenever a factory session changed) stored a full copy of the loop, adding thousands of records per project per day, and made every open factory panel reload. The panel's "last check" still shows the latest check.
