# Reference

The technical details behind CodeDen: where it keeps its data, how to configure it, the command-line options and how updates work. New to CodeDen? Start with the [README](../README.md) and [Getting started](getting-started.md).

## Configuration

| What | Where |
|---|---|
| Data directory | `~/.codeden/`, or `CODEDEN_HOME`, or `--home <dir>` |
| Port | `4317` by default, or `--port <n>`. The runner picks a free loopback port itself |
| Settings | **Settings** in the UI, stored in `<home>/settings.json` (non-secret) |
| Usage prices and budgets | **Usage** in the UI, stored in `<home>/usage-settings.json` |
| API keys | Settings, stored in the OS keychain |
| Per-project setup | `.codeden/project.json` in the repo: worktree setup commands, the dev server and the project's checks |
| Automations | `~/.codeden/automations/*.md` (all projects) and `<repo>/.codeden/automations/*.md` |
| Project vision | `<repo>/.codeden/VISION.md` (software and dark factory) |

Inside the data directory:

```
~/.codeden/
  codeden.db            SQLite database (event log + projections)
  settings.json         settings
  install-token         the per-install token (mode 600 where supported)
  server.json           running server's port and pid
  runner/               runner lock file and event journal
  wt/<project>/<id>/    agent worktrees (short paths for Windows)
  artifacts/            screenshots and files shared in chat
  orchestrator/         the orchestrator's working directory
  backups/              copies of config files taken before CodeDen overwrote them
  agent-config/         hooks you switched off on the Agents page (until you enable them)
  logs/runner.log       runner output
  deps/                 Claude Code support, installed on demand
  app/<version>/        CodeDen versions installed by one-click updates
  app/current.json      which installed version `codeden` starts
```

Two copies can run side by side with different homes and ports, for example `codeden --home ~/.codeden-test --port 4400`.

A minimal `.codeden/project.json`:

```json
{
  "setup": ["pnpm install"],
  "devServer": { "command": "pnpm dev", "port": 5173 },
  "checks": ["pnpm typecheck", { "command": "pnpm test", "timeoutSec": 900 }]
}
```

With `checks`, sessions can **keep going until checks pass**: after each turn CodeDen runs them in the session's worktree and sends failures back to the agent, up to a round cap.

## CLI reference

```
codeden [options]      Start CodeDen and open it in the browser
codeden doctor         Check the installation (--install: add Claude Code support now)
codeden update         Install the latest version and switch to it (--rollback: go back)
codeden stop           Stop the server and the runner
codeden password       Set the network access password (--generate: make one up)
codeden network on|off Let phones on your network open CodeDen, or stop it
codeden runner-link    Connect stdin/stdout to the runner in --home (run by the server
                       inside a sandbox; stdout carries only protocol frames)

Options:
  --port <n>     Port to listen on (default 4317)
  --home <dir>   Data directory (default ~/.codeden, or CODEDEN_HOME)
  --no-open      Do not open the browser
  -v, --version  Print the version
  -h, --help     Show this help
```

- Running `codeden` while it's already running prints the URL and opens it again.
- **Ctrl+C** stops the server; agents keep running in the runner. `codeden stop` stops both.
- `codeden doctor` exits non-zero when CodeDen can't run a session, and prints the one command that fixes each problem.
- Claude Code support (the Claude Agent SDK) isn't part of the package: it installs from npm into `~/.codeden/deps/` the first time it's needed, or with `codeden doctor --install`.

Environment variables: `CODEDEN_HOME` (data directory), `CODEDEN_DEBUG=1` (server log lines in the terminal), `CODEDEN_SHELL` (terminal shell; PowerShell on Windows, `$SHELL` elsewhere), `CODEDEN_GITHUB_SYNC=0` (turn GitHub polling off).

## Updating

CodeDen checks npm for a new version when it starts and every 6 hours (only the package name is sent; turn it off under **Settings > General > Updates**). When one is out, a banner says so: **What's new** shows the release notes, **Update now** installs it and restarts CodeDen, and the page reconnects on its own. Running agents are drained and resumed, the same as after any runner restart.

- **How it works.** New versions install side by side into `~/.codeden/app/<version>/`, and `~/.codeden/app/current.json` names the one to run. Whatever `codeden` you start (`npx codeden`, a global install) checks that file first and runs the newer installed version in its place, so there's nothing to reinstall by hand. The previous version is kept for rollback.
- **Install automatically.** Set **Updates** to *Install automatically* to download new versions in the background; they start the next time you open CodeDen (or right away with **Restart now**).
- **From the terminal.** `codeden update` does the same as the button (and restarts a running CodeDen); `codeden update --rollback` goes back to the previous version. `codeden doctor` lists the installed versions and which one starts.
- **Roll back** from **Settings > About** as well.
- **If it can't restart itself** (for example when started some other way), the banner says "Update installed, restart CodeDen to finish" with the command to run.
- **Running from source** (a clone of this repository) never switches versions: pull and rebuild (`git pull && pnpm install && pnpm build`).
- **The old way still works:** `npm i -g codeden@latest`, or `npx codeden@latest`. A globally installed version newer than the side-by-side one always wins.
- **Upgrading from 0.1.0:** 0.1.0 predates one-click updates; update it once by hand (`npm i -g codeden@latest` or `npx codeden@latest`).
- **The desktop app** updates itself from GitHub Releases with the same banner and the same setting; see [The desktop app](desktop.md#updates).

