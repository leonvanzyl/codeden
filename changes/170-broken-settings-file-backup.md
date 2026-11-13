---
section: fixed
---

- **A `settings.json` with a typo no longer loses your settings.** A hand edit that broke the JSON (a trailing comma, a missing quote) made CodeDen start on default settings without a word, and the next change in Settings wrote the defaults over your file. CodeDen now keeps the broken file as `settings.json.invalid-<timestamp>` before it falls back to defaults, the same as for a file with invalid values. It also warns in the server log and puts a notice in the inbox with the reason and where the old file is. `usage-settings.json` (budgets and custom prices) gets the same protection, and `codeden doctor` no longer resets a broken settings file itself.
