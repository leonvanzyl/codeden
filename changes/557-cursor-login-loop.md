---
section: fixed
---

- **Cursor's browser login no longer opens again and again on its own.** Background checks (start-up, re-checks, the factory's availability checks) asked the Cursor CLI to sign in over ACP whenever `agent status` said signed in; when the stored login could not actually be used, the CLI opened its browser login each time, and the check stopped it before the login could finish. Checks now never start a login. A login that `agent status` reports but Cursor can't use shows as "needs you to sign in again" with the `agent login` command, and a Cursor session fails with that message instead of opening the browser.
