# Getting started

From `npx codeden` to your first agent session in a couple of minutes, without typing a credential if your machine is already set up.

## 1. Check the requirements

| Requirement | Check | Notes |
|---|---|---|
| Node.js 24 or newer | `node --version` | CodeDen refuses to start on older versions |
| git | `git --version` | Set `user.name` and `user.email`: `git config --global user.name "Your Name"` |
| Claude Code, Codex CLI and/or OpenCode 2.2+ | `claude --version`, `codex --version`, `opencode --version` | At least one, **signed in** (`claude auth login`, `codex login`, `opencode auth login`; OpenCode's own free models work without an account) |
| GitHub CLI *(optional)* | `gh auth status` | Needed for issues, PRs, evidence, triage and the factory |
| Edge or Chrome *(optional)* | | For the browser panel and the agents' browser tools |

CodeDen uses your installed CLIs and their logins, including claude.ai and ChatGPT subscriptions. It never asks for a provider password or stores a provider token.

## 2. Start CodeDen

```sh
npx codeden
```

CodeDen creates its data directory (`~/.codeden/`), generates a per-install token, starts the server on `http://127.0.0.1:4317` (and the runner in the background), and opens your browser on an authenticated link. The terminal shows the URL in case the browser didn't open.

Prefer a global install?

```sh
npm i -g codeden
codeden
```

Useful flags: `--port <n>`, `--home <dir>`, `--no-open`. See the [CLI reference](../README.md#cli-reference).

## 3. The setup checklist

The first screen checks, in parallel:

- **Claude Code:** installed version, login and login expiry.
- **Codex:** installed version and login. A Codex login also makes Codex the default image engine.
- **OpenCode:** installed version (2.2 or newer) and the providers it's connected to. With none, only OpenCode's free models are available, and the row suggests `opencode auth login`.
- **GitHub CLI:** installed and signed in.
- **git:** installed, with your identity set.
- **Browser:** an installed Edge or Chrome.
- **Node.js:** version 24 or newer.

Anything that passes is never asked about. Anything missing gets one fix: the install command, or a **Sign in** button that runs the tool's own login (`claude auth login`, `codex login`, `opencode auth login`, `gh auth login`) in a terminal right on the page, so the provider's normal browser login handles it. **Sign in** runs the exact copy CodeDen found, by its full path.

CodeDen looks for Claude Code, Codex, OpenCode and the GitHub CLI on your PATH, then in their installers' own folders, such as `~/.local/bin`, where the native Claude Code installer puts `claude` even when that folder isn't on your PATH. A copy that doesn't run (for example an npm shim left behind after its package was removed) is skipped and shown as **installed but broken**, with its path; see [Troubleshooting](troubleshooting.md#claude-code-codex-or-opencode-is-installed-but-broken). **Re-check** also picks up PATH changes you made after starting CodeDen.

![The first-run setup checklist](images/setup.png)

You can re-open the checklist any time with **Run first-time setup again** at the bottom of the sidebar, or check from the terminal:

```sh
npx codeden doctor
```

CodeDen also re-checks silently on every launch and warns when something changes, such as an expiring Claude login or a CLI version that's too old.

## 4. Add a project

Click **+** next to **Projects** in the sidebar and choose:

- **Local folder.** Browse your disk with the built-in folder picker. Any folder works; GitHub features switch on when it has a GitHub remote, including one added later (by you or an agent, see [GitHub](github.md#when-a-folder-gets-a-github-remote-later)).
- **Clone from GitHub.** Paste a repository URL or `owner/repo` and CodeDen clones it.

CodeDen then opens the new project's **New session** view, ready for your first task (the last step of first-run setup lands there too).

New projects get the **starter set** of automations added, all switched **off**. Turn on the ones you want later (see [Automations](automations.md)).

### Optional: `.codeden/project.json`

Commit this file to tell CodeDen how to prepare a fresh worktree:

```json
{
  "setup": ["pnpm install"],
  "devServer": { "command": "pnpm dev", "port": 5173 },
  "defaultProvider": "codex"
}
```

- `setup` runs, in order, in every new worktree; the output streams into the session. Setup stops at the first command that fails, and the session starts anyway: the agent's first message then begins with the failed command, its exit code and the end of its output, so it can fix the problem instead of tripping over it.
- `devServer` (a command string or `{ command, port, cwd }`) records how to start your app, so agents (and the UI review automation) know what to run and where to point the browser. Running dev servers are also discovered automatically.
- `defaultProvider` (`claude`, `codex` or `opencode`) is the provider new sessions in this project use unless you pick one (a provider chosen in the project's settings wins).

## 5. Start your first session

A project you just added opens here already. Later, open the project and click **New session** (or **Start a session** while it has none, or the **+** next to the project in the sidebar). A new session opens with the message box you use in every session: describe the task ("Add a README section describing this project and a tiny test for src/math.js"), attach or paste screenshots and files if they help, pick the provider, model, effort, permissions or **Plan** under the message box if you want something other than the defaults, and send. Nothing is created until you send: the first message starts the session, and the view becomes that session. A draft you leave is kept in the browser for when you come back.

What happens next:

1. CodeDen creates a worktree under `~/.codeden/wt/` on a new `codeden/...` branch and runs your setup commands. Your own checkout is never touched. In a GitHub project it fetches first, so the branch starts from the latest default branch on GitHub even if your local copy is behind (a local default branch with commits of your own is used as it is).
2. The agent works. Tool calls are grouped into collapsible blocks with live output; plans, todos and subagents get their own cards.
3. **Risky actions ask.** With the default autonomy level the agent edits files and runs normal commands freely, but writes outside the worktree, force pushes, global installs and the like arrive as approval cards (in the chat and in the inbox).
4. When the turn ends you'll see the summary, the cost, and **follow-up chips** with suggested next prompts.
5. Open the right panel (**Ctrl/Cmd+\\**) to review the **Diff**, browse **Files**, use the **Terminal** or watch the **Browser**. Commit and push from the git bar. In a GitHub project, **Open PR** in the git bar (or in the **Issue / PR** tab) asks the agent to open a pull request: it commits what's left, pushes and writes the description, and the PR then shows in the Issue / PR tab.

![A finished turn: summary, follow-up chips and the diff](images/session.png)

## 6. Talk to the orchestrator and your PM

- **Orchestrator** (top of the sidebar): ask "What's going on across my projects?", "Create a project for ~/code/api", or "Ask the storefront PM to fix issue 12".
- **Project manager** (under each project): it can triage issues, start sessions for you, follow them and report back.

See [Orchestration](orchestration.md).

## 7. Tune the defaults

Open **Settings** (**Ctrl/Cmd+,**):

| Section | What's there |
|---|---|
| General | Theme, follow-up chips, the automations master switch, the global factory kill switch, updates, worktree cleanup |
| Providers | Default provider, model and effort for the orchestrator, PMs and agents |
| Autonomy | The default autonomy level for new sessions |
| GitHub | Connection status |
| Voice | Dictation engine, push-to-talk, read-aloud |
| Image generation | Engine, default size and quality, daily cap, API keys, a test button |
| Utility model | The small model for follow-ups, read-aloud summaries and session titles |
| Notifications | Toasts, which inbox categories notify you (needs you, failures, factory activity, automations), the chime when an agent needs you (with a test button), browser notifications |
| Keyboard shortcuts | The full list (also **Shift+?**) |

## Stopping CodeDen

- **Ctrl+C** in the terminal stops the server. Agents mid-turn keep running in the runner and are picked up again by the next `codeden`.
- `codeden stop` stops both the server and the runner.

## Next steps

- [Workbench](workbench.md): diffs, checkpoints, terminal and browser.
- [GitHub](github.md): issues, PRs and evidence.
- [Automations](automations.md): put routine work on a schedule.
- [Phones, tablets and network access](remote-access.md): open CodeDen from your phone.
- [Troubleshooting](troubleshooting.md) if anything doesn't start.
