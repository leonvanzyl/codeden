---
section: security
---

- **Trusted proxy rules.** A request that names a trusted origin's host counts as coming from another device even from this computer, so it can't use the install token or reach `/mcp`. Sign-in throttling through it keys on the forwarded address with one shared limit, and Tailscale identity headers are never trusted.
