---
section: fixed
---

- **Agents keep CodeDen's tools after a restart or upgrade.** A session reopened right after a restart could have every CodeDen MCP call rejected ("Authentication required" or a 401). This happened when a message from a PM or the factory reopened it while CodeDen was still resuming the sessions the restart cut off. The second reopen revoked the token the running agent held, so a factory reviewer could finish its review and still not record its verdict. A reopen now retires a session's earlier tokens only once the new agent process is running, and a session that a message is already reopening is not opened a second time. Stopped sessions' tokens stay revoked.
