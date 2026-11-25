---
section: fixed
---

- **A huge diff no longer freezes CodeDen.** The Diff panel drew every changed file at once, so a session whose branch moved onto another one (thousands of files, a million changed lines) used gigabytes of memory and stopped the window from responding, and, since the panel reopens where you left it, did so again on every launch. It now draws 50 files at a time with **Show more files** below them, and a file with more than 2,000 changed lines (or a very long patch) starts collapsed with its counts and a **Show diff** button. Files with review comments are always drawn, so **Show** still takes you to a comment.
