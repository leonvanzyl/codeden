---
section: fixed
---

- **Agents no longer hang on install prompts.** When pnpm had to rebuild `node_modules` (after a rebase, a lockfile change or an interrupted install), it asked "The modules directory will be removed and reinstalled from scratch. Proceed?", which nothing can answer from an agent's shell, so the install waited forever. Agent sessions now run with `CI=true`, so pnpm reinstalls without asking and other tools skip their prompts too. If you set `CI` yourself (`CI=false` to opt out everywhere), your value is kept; you can also turn it off for one project in **Settings → General → Agent environment**. Your terminals are unchanged. Inside agent sessions, your project's own tools now behave as they do in CI:
  - **Playwright:** configs with `reuseExistingServer: !process.env.CI` start their own dev server and fail when yours is already running; `forbidOnly: !!process.env.CI` fails the run on a `test.only`; `retries: process.env.CI ? 2 : 0` quietly retries failing tests.
  - **Installs:** a plain `pnpm install` won't update the lockfile, and Yarn Berry turns on `enableImmutableInstalls`, so `yarn install` fails after an agent edits `package.json` instead of updating `yarn.lock`.
  - **Builds and tests:** Create React App and similar builds treat warnings as errors, test runners don't write new snapshots, and other tools switch to CI reporters or skip interactive setup.
