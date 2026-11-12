---
section: fixed
---

- **A long review no longer loses its verdict.** The factory's reviewer could not submit a verdict whose summary was over 4,000 characters: the call was rejected, and because the reviewer was told to submit exactly once, its findings could be lost. Summaries up to 20,000 characters are now stored as written, and a longer one is stored cut, ending in "… (truncated)" (the full text stays in the reviewer's session). When any CodeDen tool rejects a call, the error now lists what to fix, with the length and the limit for text that is too long, and says to call the tool again. Reviewers still submit one verdict, but a call rejected for invalid input doesn't count.
