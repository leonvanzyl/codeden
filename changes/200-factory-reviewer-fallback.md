---
section: fixed
---

- **Factory reviews no longer fail when a provider is at its usage limit or signed out.** New builders and reviewers only start on a provider that is installed, signed in and not at its usage limit. A review that would have run on such a provider runs on the builder's provider instead, and the item notes why ("Codex is at its usage limit until Tue 06:00"). A reviewer that stops on a usage limit, a sign-in problem or a failed start restarts on an available provider, without failing the review or using a revise round. With no provider available, the review waits and says until when.
