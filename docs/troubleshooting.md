# Troubleshooting

## Start with `doctor`

```sh
npx codeden doctor
```

It runs the same checks as the setup screen and prints one line per item, then the command that fixes each problem:

```
ok  CodeDen              0.1.0
ok  Data directory       C:\Users\you\.codeden
ok  Server               running on port 4317 (pid 12345)
ok  Runner               running on port 51234 (pid 12346)
ok  Terminals            node-pty
ok  Keychain             @napi-rs/keyring
ok  Claude Code          2.1.318 - Signed in
ok  Claude Code support  SDK 0.3.318 in C:\Users\you\.codeden\deps
--  Codex                Codex is not installed
ok  OpenCode             2.2.7 - Connected: Anthropic, OpenAI
ok  GitHub CLI           2.83.0 - Signed in
ok  git                  2.51.0 - Identity configured
ok  Browser              Microsoft Edge
ok  Node.js              Node.js 24.16.0

To fix:
  Codex: npm install -g @openai/codex
```

`ok` passed, `!!` is a warning, `--` is missing, `xx` is an error. `doctor` exits non-zero when CodeDen can't run a session (no signed-in agent provider, or Node or git missing). Use `--home <dir>` to check another data directory.

## Logs and state

| What | Where |
|---|---|
| Runner output | `~/.codeden/logs/runner.log` |
| Server log lines | Run with `CODEDEN_DEBUG=1 codeden` to print them in the terminal. The desktop app always writes them to `~/.codeden/logs/desktop-server.log` (moved to `desktop-server.log.1` past 5 MB) |
| Running server | `~/.codeden/server.json` (port and pid) |
| Running runner | `~/.codeden/runner/runner.json` (port, pid and version) |
| Database | `~/.codeden/codeden.db` (SQLite, WAL mode) |
| Config-file backups | `~/.codeden/backups/` |
| Claude Code support (Claude Agent SDK) | `~/.codeden/deps/` |

On Windows `~` is your user folder, for example `C:\Users\you\.codeden`. If you set `CODEDEN_HOME` or `--home`, look there instead.

## Common problems

### "Port 4317 is in use"

Another program (or another CodeDen with a different home) has the port. Start on another one:

```sh
codeden --port 4400
```

If it's a stale CodeDen, `codeden stop` then start again.

### The page says "CodeDen is locked"

The browser doesn't have the install token cookie, for example after clearing cookies, using another browser, or changing the port. Run `codeden` again: it prints and opens an authenticated link, even when CodeDen is already running.

### "CodeDen needs Node.js 24 or newer"

Install Node.js 24 or later from <https://nodejs.org>, or with your version manager (`nvm install 24`, `fnm install 24`, `volta install node@24`). Check with `node --version` in the same terminal you run `npx codeden` from.

### Claude Code, Codex or OpenCode is installed but broken

The setup row says, for example, **"Claude Code is installed but broken: `C:\Users\you\AppData\Roaming\npm\claude.cmd` points at a missing package. Reinstall it, or remove the leftover shim."** CodeDen found the tool's file, but it doesn't run. Usually it's an npm shim (`claude.cmd`, `claude.ps1`, or a link in npm's `bin` folder) whose package was removed or only half installed. Typing `claude` in a terminal fails the same way, often with *"The term '' is not recognized"* in PowerShell. Open **Details** on the row to see every broken copy and what it points at.

Fix it in one of two ways:

- **Reinstall** the tool the way you want to use it, for example the native installer (`irm https://claude.ai/install.ps1 | iex` on Windows, `curl -fsSL https://claude.ai/install.sh | bash` elsewhere) or `npm install -g @anthropic-ai/claude-code`.
- **Remove the leftover shim** if you've moved to another install. With npm: `npm uninstall -g @anthropic-ai/claude-code` (or `@openai/codex`), then delete any `claude*` / `codex*` files left in npm's global folder (`%APPDATA%\npm` on Windows, `$(npm prefix -g)/bin` elsewhere).

Then press **Re-check**. You don't need to restart CodeDen.

Where CodeDen looks, in order:

1. Your PATH, as CodeDen sees it. On Windows, **Re-check** first adds folders that were added to your user or system `Path` since CodeDen started.
2. The installers' own folders, even when they aren't on your PATH:
   - Claude Code: `~/.local/bin/claude` (`%USERPROFILE%\.local\bin\claude.exe` on Windows), then `~/.claude/local/claude`.
   - Codex: `~/.local/bin/codex`, then `~/.codex/packages/standalone/current` (or under `CODEX_HOME`).
   - OpenCode: `~/.opencode/bin/opencode` (`%USERPROFILE%\.opencode\bin\opencode.exe` on Windows), where its install script puts it; `/opt/homebrew/bin/opencode` and `/usr/local/bin/opencode` on macOS.
   - Cursor CLI: `cursor-agent`, or an `agent` whose version is Cursor's (`2026.10.22-…`): `~/.local/bin/agent`, and `%LOCALAPPDATA%\cursor-agent\agent.cmd` on Windows.
   - Gemini CLI: npm's global folder (on your PATH); `/opt/homebrew/bin/gemini` and `/usr/local/bin/gemini` on macOS.
   - GitHub CLI: `C:\Program Files\GitHub CLI\gh.exe` on Windows; `/opt/homebrew/bin/gh` and `/usr/local/bin/gh` on macOS.

The first copy that answers `--version` is used for detection, for sessions and for **Sign in**, so a working native install wins over a broken shim earlier on PATH. When the native installer says its folder *"is not in your PATH"*, CodeDen still finds it; add the folder to your PATH if you also want `claude` to work in your own terminals.

### Claude Code, Codex or OpenCode shows as not signed in

Use **Sign in** on the setup checklist, or run the CLI's own login in a terminal and re-check:

```sh
claude auth login
codex login
opencode auth login
agent login
gemini
gh auth login
```

A Claude login close to expiry shows as a warning; signing in again clears it.

**Sign in** runs the copy CodeDen found by its full path (in PowerShell, for example `& 'C:\Users\you\.local\bin\claude.exe' auth login`), so it works even when that copy isn't on your PATH. If the row says **"Could not read the Claude login state"**, CodeDen ran `claude auth status` but couldn't understand the answer. Open **Details** to see the exit code and output.

OpenCode with no connected provider is a warning rather than an error: its own free models work without an account. `opencode auth login` connects a provider (Anthropic, OpenAI, and many more); API keys in your environment and providers in `opencode.json` count too. CodeDen checks with `opencode auth list --standalone`, which runs a private OpenCode server for a few seconds and never starts or touches OpenCode's background service.

### CodeDen's sessions show up in the Codex app

The Codex apps (the ChatGPT desktop app's Codex, the Codex IDE extension) list every Codex conversation on your machine as yours, including the ones CodeDen starts for factory reviewers, builders, PMs and other sessions. CodeDen keeps its own out of that list: it archives a session's Codex conversation whenever no turn of it is running, and unarchives it just before the next turn, a resume or a fork. Your own conversations are never touched. A session that is running a turn shows in the Codex app until the turn ends, and one whose agent started Codex sub-agents stays until you stop or archive the session. A turn that fails to start, or a Codex process that crashes, still has its conversation archived. If CodeDen itself is killed mid-turn, it archives what was left listed the next time it starts.

Sessions from older CodeDen versions are still listed. To hide them, open **Settings → Providers → Provider apps** and choose **Review** next to **Hide CodeDen's sessions from the Codex app**. CodeDen lists the conversations it started that the Codex app still shows (found by its own record of them, never by their titles) and archives them once you confirm. They are archived, not deleted: they appear under the Codex app's archived conversations, and CodeDen can still resume and fork them.

Claude Code, OpenCode and Gemini CLI don't add CodeDen's sessions to your own lists. Claude Code labels them as SDK sessions, which its `/resume` leaves out. OpenCode's are archived. Gemini CLI lists sessions per folder, and CodeDen's run in their own worktrees.

### The Cursor CLI asks for `agent update`

CodeDen drives the Cursor CLI through its ACP server (`agent acp`), which older builds don't have. Run `agent update` (or reinstall with `curl https://cursor.com/install -fsS | bash`, or `irm 'https://cursor.com/install?win32=true' | iex` on Windows), then press **Re-check**. Another program named `agent` on your PATH isn't Cursor's: CodeDen only uses an `agent` whose `--version` is a Cursor build, and prefers `cursor-agent` when both are installed.

Cursor's own permission settings (`~/.cursor/cli-config.json`, a project's `.cursor/cli.json`) apply before CodeDen's: what they allow runs without asking, so CodeDen can only judge what Cursor asks about. Keep their allowlists short if you rely on CodeDen's levels. A session whose worktree has `permissions.allow` rules in `.cursor/cli.json` names them in a warning in its first turn, and an agent that tries to change either file asks you first (except Codex, whose writes inside its sandbox CodeDen doesn't see; see [Agents' own allow-lists](security.md#agents-own-allow-lists)).

### "This worktree has Gemini CLI settings that run tools without asking"

The project's `.gemini/settings.json` lets some tools run without asking (`tools.allowed`, `tools.autoAccept`, `mcp.allowed`, or an MCP server marked `trust`), or its `.gemini/policies` files have `allow` rules. CodeDen starts Gemini CLI with an admin policy that still asks before commands, and before edits and MCP tools outside plan mode, but anything else those settings allow runs without CodeDen seeing it. Remove the settings if you didn't add them on purpose. If Gemini CLI prints "Ignoring --admin-policy because system policies are already defined", your machine has Gemini CLI system policies, and those decide instead of CodeDen's.

### A Gemini CLI deny rule doesn't apply in CodeDen

CodeDen repeats your Gemini CLI rules for commands, edits and MCP tools above its own admin policy, so what they deny stays denied (see [Permissions](security.md#permissions)). It reads them when a session starts, from `~/.gemini/policies` (in `$GEMINI_CLI_HOME` when set), the project's `.gemini/policies`, and the tool and MCP server lists of your and the project's `settings.json`. A rule elsewhere isn't repeated: in a Gemini CLI extension, in system settings, or in a folder named by `policyPaths`. Move it to `~/.gemini/policies`. A policy file Gemini CLI can't load (not TOML, or a rule with a field it doesn't accept) is skipped whole, as Gemini CLI skips it. Start a new session after changing your rules.

### Gemini CLI asks for an update, or its login can't be confirmed

CodeDen needs Gemini CLI **0.68.0** or newer: older versions don't say which MCP server a tool call belongs to, so CodeDen's own tools would be refused in read-only sessions. Run `npm install -g @google/gemini-cli@latest` (or `brew upgrade gemini-cli`), then press **Re-check**.

Gemini CLI has no command that reports its login, so CodeDen reads the method you chose in Gemini CLI's settings (`~/.gemini/settings.json`, or under `GEMINI_CLI_HOME`), your Google account's email, and which login variables are set, never a credential:

- **"Not signed in to Gemini CLI"**: no login method is chosen and `GEMINI_API_KEY` isn't set. **Sign in** runs `gemini`, which asks how you want to sign in (Google, a Gemini API key or Vertex AI); finish there, close it, then **Re-check**.
- **"Could not confirm the Gemini CLI login"**: you chose a method CodeDen can't see from outside, such as a Google login kept in your system keychain, or `GEMINI_API_KEY` in a `.env` file Gemini CLI reads but CodeDen's environment doesn't have. Sessions still start; if one fails with "Gemini CLI is not signed in", run `gemini` once in a terminal and sign in.

CodeDen never signs Gemini CLI in itself, so it never changes the login method you chose. Gemini CLI's own permission rules apply before CodeDen's: what its policy files, `tools.allowed` or an MCP server marked `trust` in its settings allow runs without asking, so CodeDen can only judge what Gemini CLI asks about.

### OpenCode is installed but shows as unsupported

CodeDen drives OpenCode 2 (its v2 server API, 2.2 or newer). OpenCode 1 (the `opencode-ai` npm package) is a different API. Install OpenCode 2 with `npm install -g @opencode/cli` (or `curl -fsSL https://opencode.ai/v2/install | bash`), and update an older 2.x with `opencode upgrade`.

### "Claude Code support could not be installed"

CodeDen doesn't ship the Claude Agent SDK. The first time it's needed (on the setup screen, or by the first Claude session), CodeDen installs it from npm into `~/.codeden/deps/`. That's about 5 MB, without the SDK's platform binaries or peer packages. If the install fails, the setup row and the session error show npm's reason, usually a network, proxy or registry problem. Fix that, then retry in one of these ways:

- **Retry** on the Claude Code support row (Settings > First-run setup).
- Start the Claude session again.
- Run `npx codeden doctor --install`, which prints npm's output as it installs.

npm uses your normal configuration (`.npmrc`, `npm_config_registry`, proxy settings). If the folder ends up broken, delete `~/.codeden/deps/` and retry. A `.install.lock` left by a crashed install is cleared automatically once its process is gone, or after 10 minutes.

### An update failed or won't apply

One-click updates install into `~/.codeden/app/<version>/` with npm, then CodeDen restarts into the new version (see [Updating](../README.md#updating)).

- **"Couldn't update to X: npm install exited ..."**: npm's reason follows, usually a network, proxy or registry problem. npm uses your normal configuration (`.npmrc`, proxy settings). Fix it, then press **Retry**, or run `codeden update` to see npm's full output.
- **"Update installed. Restart CodeDen to finish"**: CodeDen couldn't restart itself (it wasn't started by the `codeden` command, or the new version didn't answer within two minutes). Run `codeden stop`, then start it again the usual way; the new version starts.
- **"CodeDen X exited before it started"**: the new version crashed on start, so CodeDen went back to the old one and shows the error. Check the terminal output, then retry or report it. `codeden update --rollback` (or **Roll back** in Settings > About) also goes back.
- **"CodeDen X ... can't start (...); running Y instead"**: the installed version's files are incomplete (an interrupted install, cleaned folder or antivirus). Run `codeden update` to reinstall it, or delete `~/.codeden/app/<version>/` and `~/.codeden/app/current.json` to run the copy you launched.
- **`codeden` still starts the old version**: run `codeden doctor` and look at *Launched copy*, *Installed versions* and *Current version*. A copy you launched that is newer than the installed one always wins (for example after `npm i -g codeden@latest`), and a source checkout never switches.
- **`npx` keeps an old copy**: that's fine: the npx copy only launches the version in `~/.codeden/app`. To refresh npx's own copy, run `npx codeden@latest` once.
- A `.install.lock` in `~/.codeden/app` left by a crashed install is cleared once its process is gone, or after 10 minutes. Old versions are pruned to the current and previous ones; a folder still in use on Windows is removed on a later update.

### "older than the tested minimum"

CodeDen pins the Claude Agent SDK and the Codex protocol to versions it has been tested against, and reports CLIs that are too old (Claude Code 2.1.250+, Codex 0.160.0+, OpenCode 2.2.0+). Update them:

```sh
claude update
npm install -g @openai/codex@latest
opencode upgrade
```

### "The runner exited during start-up" or "did not start within 300 s"

While CodeDen waits for its runner, the sidebar says **Starting the runner…**. A slow start (security software scanning files, a busy or cold disk) is waited for; CodeDen only gives up on a runner that hasn't started after five minutes. If the runner process exits during start-up, the error (hover the status in the sidebar, or see the server log) ends with the last lines of `~/.codeden/logs/runner.log`. A native module that failed to load (`node-pty`) usually means a broken or partial install: run `npm cache clean --force`, then `npx codeden@latest`. Security software that blocks new processes can also cause it.

### Tests, installs or builds behave differently in agent sessions

Agent sessions run with `CI=true`, because an agent's shell can't answer prompts (such as pnpm's "The modules directory will be removed and reinstalled from scratch. Proceed?"). Your project's tools then behave as they do in CI:

- **Playwright:** with `reuseExistingServer: !process.env.CI`, the agent's test run starts its own dev server and fails if yours is already running; `forbidOnly: !!process.env.CI` fails on a `test.only`; `retries: process.env.CI ? 2 : 0` retries failing tests without saying so.
- **Installs:** `pnpm install` keeps the lockfile frozen, and Yarn Berry turns on `enableImmutableInstalls`, so `yarn install` fails after an agent edits `package.json` instead of updating `yarn.lock`.
- **Builds and tests:** Create React App and similar builds fail on warnings, test runners don't write new snapshots, and other tools switch to CI reporters or skip interactive setup.

To turn it off for one project, use **Settings → General → Agent environment** (or ask the orchestrator). Agent sessions opened after that get no `CI` from CodeDen; a session that's already running keeps its environment until it restarts. With it off, pnpm may ask again before reinstalling `node_modules`, so add `confirmModulesPurge: false` to the project's `pnpm-workspace.yaml`. To turn it off everywhere, set `CI=false` in the environment you start CodeDen from. Your own terminals never get `CI` from CodeDen.

### Agents keep running after I close the terminal

That's by design: the runner outlives the server so agents survive restarts. `codeden stop` stops both.

### The browser panel is empty or says no browser was found

CodeDen uses an installed **Microsoft Edge** or **Google Chrome**. Install one, then re-check from the setup screen. The browser starts the first time you or an agent opens it.

### GitHub features are missing

- The folder needs a GitHub remote (`git remote -v`).
- `gh auth status` must show you signed in. **Settings → GitHub** shows what CodeDen sees.
- If you set `CODEDEN_GITHUB_SYNC=0`, polling is off.

### An automation didn't run

Check, in order: the master switch (**Settings → General → Automations**), the project's automations switch, the automation's own switch, whether the PM paused it, and its **Runs** tab. Skipped runs say why (`overlap`, `quiet_hours`, `daily_cap`, `factory_intake`, ...). A file automation with a YAML error is listed with the error on the Automations page.

### The factory isn't doing anything

Open the factory panel. A **paused** loop shows its reason (budget reached, repeated failures, a revert); resume it once you've looked. A **stopped** loop means a kill switch is on, either the project's or **Settings → General → Global factory kill switch**. Only issues opened after you enabled the mode, or labelled `codeden-factory`, are picked up.

## Windows notes

CodeDen is tested on Windows first. Things worth knowing:

- **Install the CLIs normally.** The native Claude Code installer (`claude.exe`) and the npm `claude.cmd` / `codex.cmd` shims all work; CodeDen unwraps npm shims itself, so no shell is involved. The native installer's `%USERPROFILE%\.local\bin` is found even when it isn't on your PATH, and a PATH you change while CodeDen runs is picked up on **Re-check** (see [installed but broken](#claude-code-codex-or-opencode-is-installed-but-broken)).
- **Terminal shell.** Terminals open **PowerShell** (`powershell.exe`). To use PowerShell 7 or Git Bash, set `CODEDEN_SHELL` before starting, for example in PowerShell:

  ```powershell
  $env:CODEDEN_SHELL = "pwsh.exe"; npx codeden
  ```

- **Long paths.** Worktrees live under short paths (`~/.codeden/wt/<project>/<session>/`) to stay clear of the 260-character limit, but very deep repositories can still hit it. Enable long paths in git with `git config --global core.longpaths true`.
- **Keychain.** API keys are stored in **Windows Credential Manager** under the service name `codeden`. If the keychain module can't load, CodeDen keeps keys in memory until it stops (start with `CODEDEN_DEBUG=1` to see why).
- **Files in use.** Antivirus scanners and editors with the worktree open can briefly lock files; if removing a session's worktree fails, close what has it open and try again. Programs CodeDen's agents started there (a dev server run through the agent's shell) are ended before the removal, and when the session stops; your own editors and terminals are left alone. A removal that still fails shows up in the inbox under **Worktrees not removed**, with **Try again**.

## Starting fresh

To reset CodeDen completely, stop it and remove the data directory. This deletes your projects list, sessions, transcripts, usage history and worktrees under `~/.codeden/wt/` (commit or push anything you want to keep first). Your repositories and your provider, GitHub and keychain logins are not touched.

```sh
codeden stop
# then delete ~/.codeden (or your CODEDEN_HOME)
```

Still stuck? [Open an issue](https://github.com/leonvanzyl/codeden/issues) with the `codeden doctor` output and the end of `runner.log` (check it for anything private first).
