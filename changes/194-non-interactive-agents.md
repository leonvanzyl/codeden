---
section: fixed
---

- **Agents no longer hang on install prompts.** When pnpm had to rebuild `node_modules` (after a rebase, a lockfile change or an interrupted install), it asked "The modules directory will be removed and reinstalled from scratch. Proceed?", which nothing can answer from an agent's shell, so the install waited forever. Agent sessions now run with `CI=true`, so pnpm reinstalls without asking and other tools skip their prompts too. Tools that read `CI` behave inside agent sessions as they do in CI: for example, a plain `pnpm install` won't update the lockfile, and test runners don't write new snapshots. If you set `CI` yourself (`CI=false` to opt out), your value is kept. Your terminals are unchanged.
