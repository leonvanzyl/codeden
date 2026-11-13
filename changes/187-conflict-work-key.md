---
section: fixed
---

- **Wait and Join on the "Already running" card keep to the work that conflicted.** If the New session draft had no typed work key and you edited its text after the card appeared, the edited text produced a different work key, so Wait, Join and Force started a new session alongside the running work. They now start your edited draft under the work key that conflicted, so Wait queues behind that work and Join sends the draft to it. If you change the typed work key, the card asks you to send the draft again so the new key is checked for running work.
- **Sending a conflicting draft again always closes the conflict it replaces.** The earlier conflict was looked up among the 500 most recent conflict records only, so an older one, together with its inbox item, stayed open next to the new one. It is now found by its id, however old it is.
