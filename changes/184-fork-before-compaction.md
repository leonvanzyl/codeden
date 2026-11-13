---
section: fixed
---

- **Fork from here works on Claude turns from before a context compaction.** In a long Claude session, forking at any turn before the latest compaction failed with "The conversation no longer holds the end of that turn", although the conversation still held it. The copy now ends with that turn. A turn the conversation really no longer holds is still refused, and nothing is copied.
