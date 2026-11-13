---
section: fixed
---

- **A runner removed or shut down while it is still connecting stays disconnected.** Removing a runner or closing the server while CodeDen was still finding or connecting to it could finish the connection anyway: the runner was recorded as connected again after it had been deleted, and it kept answering commands after the server had closed. Removing a runner or closing the server now cancels the connection and waits for it to end, and a connection that completes too late is closed without being recorded.
- **"Runner not connected" errors give the runner's id.** When a session's runner is not connected, the error now gives the runner's id along with its name and backend, so you can tell which runner the session lost, as the error for a deleted runner already did.
