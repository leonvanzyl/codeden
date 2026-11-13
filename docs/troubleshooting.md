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
   - GitHub CLI: `C:\Program Files\GitHub CLI\gh.exe` on Windows; `/opt/homebrew/bin/gh` and `/usr/local/bin/gh` on macOS.

The first copy that answers `--version` is used for detection, for sessions and for **Sign in**, so a working native install wins over a broken shim earlier on PATH. When the native installer says its folder *"is not in your PATH"*, CodeDen still finds it; add the folder to your PATH if you also want `claude` to work in your own terminals.

### Claude Code, Codex or OpenCode shows as not signed in

Use **Sign in** on the setup checklist, or run the CLI's own login in a terminal and re-check:

```sh
claude auth login
codex login
opencode auth login
gh auth login
```

A Claude login close to expiry shows as a warning; signing in again clears it.

**Sign in** runs the copy CodeDen found by its full path (in PowerShell, for example `& 'C:\Users\you\.local\bin\claude.exe' auth login`), so it works even when that copy isn't on your PATH. If the row says **"Could not read the Claude login state"**, CodeDen ran `claude auth status` but couldn't understand the answer. Open **Details** to see the exit code and output.

OpenCode with no connected provider is a warning rather than an error: its own free models work without an account. `opencode auth login` connects a provider (Anthropic, OpenAI, and many more); API keys in your environment and providers in `opencode.json` count too. CodeDen checks with `opencode auth list --standalone`, which runs a private OpenCode server for a few seconds and never starts or touches OpenCode's background service.

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
