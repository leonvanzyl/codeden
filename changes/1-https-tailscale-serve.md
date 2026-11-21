---
section: added
---

- **HTTPS through Tailscale Serve.** `codeden network origin add https://<machine>.<tailnet>.ts.net:8445` trusts a reverse proxy on the same computer, so a phone gets notifications, dictation and Add to Home Screen over HTTPS. Requests through it always need the password sign-in, never the install token. `codeden network on --loopback-only` (also in Settings › Network access) keeps CodeDen on 127.0.0.1 so the proxy is the only way in. See docs/remote-access.md.
