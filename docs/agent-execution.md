# Agent execution model: design and plan

> Status: **proposed 2026-11-14**, from a design spike (#274). It builds on [remote-runners.md](remote-runners.md), which stays the plan for sandboxes. Section 9 proposes changes to `docs/DESIGN.md`, including its **Locked decisions**. They are marked **Needs the user's approval** and change nothing until the user signs off. Issue 1 in §8 is a security fix that needs no approval and can start at once.

CodeDen runs each agent's own CLI (`claude` through the Agent SDK, `codex app-server`, `opencode serve`, `agent acp`, `gemini --acp`) as the user, on the user's machine, against the user's own provider homes (`~/.claude`, `~/.codex`, …). This spike asks whether that should change: per-session provider homes, containers on the user's machine, or containers always. It records what was checked, the recommendation, the migration from today, and the work as issue drafts.

## 1. Recommendation at a glance

| # | Question | Recommendation | Why, in one line |
|---|---|---|---|
| 1 | Where do agents run by default? | **On the host, as today.** Containers stay opt-in per project or session (remote runners phases 4–7) | Containers can't build Windows-native projects. They need Docker Desktop on Windows and macOS, and they lose the user's toolchains, logins and native browser views (§3) |
| 2 | Provider homes | **One provider-home module in the runner.** It gives a session either the user's own home or a **per-session home** (`<home>/agent-homes/<project>/<session>/<provider>/`) holding a copy of the user's config, never their history | Keeps CodeDen's threads out of the user's apps (#273) and makes sandboxes and multi-session boxes possible with the same code (§4) |
| 3 | Which providers get a per-session home on the host? | **Codex** (when its login is a file or an API key), and **Cursor** if #277 confirms it leaks. Claude Code, OpenCode and Gemini CLI keep the user's home on the host. **Every provider in a sandbox** | Only Codex (and probably Cursor) lists CodeDen's sessions in the user's own apps. Claude's memory, skills, plugins, hooks and macOS Keychain login live in the user's home (§2.2, §4.2) |
| 4 | Logins | **A login broker in the runner**, per provider. It hands a login over per turn and writes refreshed tokens back to their source only when they are newer. Preference order: environment credential, then Codex external tokens, then a per-turn file copy | OAuth refresh tokens can rotate. A copy that refreshes without writing back breaks the user's own CLI (§5) |
| 5 | Codex logins in the long run | **External tokens** (`chatgptAuthTokens`): the session's Codex holds only an access token and asks CodeDen to refresh it, so the refresh token never leaves the broker, or the home runner when the session is in a sandbox | Codex's own rule is "one `auth.json` per runner". Probe: it needs Codex's experimental API (§5.3) |
| 6 | SDK or headless CLI turns? | **Keep the Agent SDK and the protocol adapters** (as remote-runners decision 1) | Headless turns lose approvals, steering, interrupt, plan mode and live subagents. They gain nothing for per-session homes, which work through `env` (§6) |
| 7 | Containers always (option D)? | **No** | It breaks the one-minute first run, offline first use, Windows-native work and the desktop app's native browser (§3.3) |
| 8 | Provider login files | **Secrets for the risk classifier now**, asking at every level | Probe: at Auto, `cat ~/.codex/auth.json` and `cat ~/.claude/.credentials.json` run without asking today (§2.3) |

## 2. Today (option A), as built

### 2.1 How each adapter finds its home and login

Every agent process gets the runner's environment minus CodeDen's own variables (`agentEnv`, `packages/providers/src/util/agent-env.ts`), plus `SessionOptions.env` and `CI=true` (`agentSessionOptions`, `apps/runner/src/session-env.ts`). Nothing sets a provider home, so each CLI uses the user's own.

| Provider | Home, and what moves it | Login | History CodeDen's sessions write |
|---|---|---|---|
| Claude Code | `~/.claude` and `~/.claude.json`; `CLAUDE_CONFIG_DIR` moves both (`claudeHomes`, `claude/session.ts`) | `.credentials.json` in the config folder on Windows and Linux; the Keychain on macOS; or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | `projects/<encoded cwd>/<session>.jsonl`, one folder per worktree path |
| Codex | `$CODEX_HOME`, default `~/.codex` | `auth.json`, or the OS keyring (`cli_auth_credentials_store`: `file`, `keyring`, `auto`, `ephemeral`); or `CODEX_API_KEY` / `OPENAI_API_KEY` | `sessions/…` rollouts plus SQLite state; listed in the Codex apps' recents (#273) |
| OpenCode | Its own config and data folders; CodeDen layers `OPENCODE_CONFIG_CONTENT` on top (`opencode/server.ts`) | Its own `auth.json` per connected provider, or provider keys in the environment | Its own database; CodeDen archives each session on create and resume (`opencode/session.ts`) |
| Cursor | `~/.cursor` | `agent login`, or `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | Chats likely listed across workspaces by `agent ls` and `/resume` (#277, unverified) |
| Gemini CLI | `~/.gemini`; `GEMINI_CLI_HOME` moves it (`gemini/auth.ts`) | `oauth_creds.json` or the system keychain; or `GEMINI_API_KEY` and the other login variables | Per project folder; worktrees are separate folders |

One-shot jobs (the utility model, image generation through Codex) already start Codex threads with `ephemeral: true` (`codex/one-shot.ts`, `image/codex-turn.ts`), so they leave no history.

### 2.2 What sharing the user's homes costs

- **History in the user's apps.** Codex lists every CodeDen thread in its recents (#273; the reporter had 121, 74 of them factory reviewers). The fix in progress (#278) archives each thread when no turn runs and unarchives it before the next turn, resume or fork, because Codex refuses to resume an archived thread. That works, but it is a protocol dance on every turn, and archived threads still fill the Codex app's archived list. Claude Code leaves SDK sessions out of `/resume` (#278 pins `CLAUDE_CODE_ENTRYPOINT=sdk-ts` so this holds when CodeDen is started from a Claude Code terminal). OpenCode is archived already, and Gemini CLI's history is per folder. Cursor is open (#277).
- **Disk that is never cleaned.** Removing a worktree leaves the provider's own transcripts behind (`~/.claude/projects/<worktree path>/`, `~/.codex/sessions/…`). The vision says CodeDen doesn't waste space.
- **Config shared both ways.** A change to a provider's user config (an MCP server, a model, a trust entry) reaches the user and every session at once. An agent's own edits there are writes outside the worktree, so they ask at every level (§11.2), but one approval reaches every later session too, and the user's own config changes reach running factories without notice.
- **Concurrent use of one login.** Every session and the user's own CLI share one login file. This works today because each CLI refreshes and re-reads the same file.

### 2.3 Finding: provider login files are not secrets to the classifier

Checked with the classifier itself (`classifyCommand`, `classifyRead` in `packages/providers/src/policy/risk.ts`, worktree `/work/repo`):

```text
cat ~/.codex/auth.json            {"risky":false}
cat ~/.claude/.credentials.json   {"risky":false}
read /home/me/.codex/auth.json    {"risky":false}
cat ~/.ssh/id_ed25519             {"risky":true,"action":"secrets",...}
cat .env                          {"risky":true,"action":"secrets",...}
```

`isSecretPath` (`policy/paths.ts`) knows `.env`, SSH keys, `.npmrc`, `credentials.json` and `.ssh`/`.aws`/`.gnupg`/`.docker` folders. It doesn't know `.claude/.credentials.json`, `.codex/auth.json`, `.gemini/oauth_creds.json`, OpenCode's `auth.json` or `gh/hosts.yml`. So a prompt-injected agent at Auto can read the user's subscription logins into its context without asking. Only the level's network rules then stand between them and an outside host, and Full allows the network. This holds in every option below, so it is fixed first, on its own (§8, issue 1). The agent's own CLI never needs a tool call to read its login, so asking at every level costs nothing in normal work, the same as for CodeDen's own credential files.

## 3. The options compared

- **A. Today.** A host runner, adapters over each CLI's protocol, the user's own provider homes.
- **B. Per-session provider homes on any runner**, with logins brokered per turn.
- **C. B, plus an optional container per session** on the user's machine: the `docker` backend, remote runners phase 4.
- **D. Containers always**, even for local sessions.

### 3.1 Summary

| | A. Today | B. Per-session homes | C. B + opt-in container | D. Containers always |
|---|---|---|---|---|
| Isolation from the user's files | None: the agent is the user | None at the OS level. Sessions don't share provider state, and an approved edit to an agent's provider config stays in its own session | A container per session that opts in: no access to the user's home, SSH keys or other projects | The same, for every session |
| Prompt-injection blast radius | The user's account | The user's account | The container, plus whatever its login and GitHub credential reach | The same as C |
| Allow-list bypass (#232) | Guarded by the classifier | The same | The same; a file written in the container still lands in the repo through a PR | The same as C |
| History in the user's apps | Codex yes (archived by #278), Cursor likely | None for isolated providers | None | None |
| User's config (memory, skills, MCP, hooks) | Native, live | Copied in at session open; Claude keeps the user's home on the host | Copied in; macOS Keychain logins and absolute paths in the config don't carry over | The same as C, always |
| Credentials | Each CLI's own | Broker, per turn, with write-back | Broker over the link (remote-runners §14) | Always over the link |
| Windows and macOS | Native | Native | Needs Docker Desktop (a paid subscription in larger companies) or Docker Engine; Linux containers only | Required for everyone |
| Startup, disk, RAM | A worktree per session | Plus a small home folder per session (a new Codex home holds five SQLite databases) | Plus a ~1.94 GB image (the spike's), a clone per session, the Docker VM's RAM | The same as C for every session |
| Offline | Works (model calls aside; local models through OpenCode work) | Works | Works once the image is built | First run needs the network for the image |
| `npx codeden` and desktop first run | Under a minute (§14) | Unchanged | Unchanged until a project opts in | Install Docker, then build an image |
| Browser | Runner's Chromium, native views in the desktop app | The same | Chromium in the container, screencast only (no native views, remote-runners §12) | Screencast only, always |
| Terminals | node-pty on the host | The same | node-pty in the container, over the link | The same as C |
| Computer use | Browser pointer actions | The same | The same, plus a later virtual desktop in the image ("agent computers") | The same as C |
| Windows-native projects (.NET, PowerShell, MSBuild) | Yes | Yes | No | No |

### 3.2 Notes on the hard rows

- **B is hygiene, not a sandbox.** A per-session home keeps provider state apart. The agent still runs as the user and can read anything the user can. The real boundaries are the risk classifier (§11.2), the provider's own sandbox (Codex), and a container (C). The docs must say so plainly.
- **Prompt injection in C.** Inside a container the agent can still read its own login: the provider process needs it. External tokens (Codex, §5.3) and the inference-only `claude setup-token` token narrow what a stolen login is worth. The brokered GitHub credential (remote-runners §9.2) keeps the user's GitHub token out of the sandbox between git operations.
- **Docker Desktop reaches the host's loopback** (remote-runners §7): the install token and MCP session tokens are the boundary, not the bind address. C keeps that rule.
- **The user's config in a container.** A Linux container can't use a macOS Keychain login, Windows paths in `config.toml`, MCP servers that run host programs, or the user's SDKs and databases. That is fine for an opt-in backend that clones GitHub projects. It would be a regression as the default.

### 3.3 Why not D

D makes every user install Docker before the first session and download or build an image of about 2 GB, which breaks the one-minute first run (§14) and offline first use. On Windows and macOS it adds a Linux VM that holds several GB of RAM. It can't build Windows-native projects, and it gives up the desktop app's native browser views and the user's own toolchains. Its gain over C is isolation for users who didn't ask for it. C already offers that per project, and per session, at the cost the user chooses.

## 4. Per-session provider homes (B)

### 4.1 One module in the runner

Provider homes are a runner concern, so they work the same on the host and in any sandbox:

- **Each adapter describes its home** (`ProviderHomeSpec`, contracts first): the environment variable that moves it (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, …), which entries are **config** to copy in, which are **login** (handed over by the broker, §5), and that everything else is **state** that stays per session. The UI and orchestration read it as a capability, never a provider id.
- **The runner prepares the home** when a session opens (start or resume), in `agentSessionOptions` or next to it, and adds the variable to the session's `env`. Layout: `<home>/agent-homes/<project>/<session>/<provider>/`, parallel to `wt/<project>/<session>/` and as short. In a sandbox `<home>` is the sandbox runner's home.
- **Config files are copied; config folders are linked.** Files are copied, since Windows file symlinks need Developer Mode. Folders that the user edits through CodeDen's Agents page (skills, prompts, agents) are linked: a junction on Windows, a symlink elsewhere. A write through a link is a write outside the worktree, which asks as today. The copy is refreshed every time the session opens, so edits made on the Agents page (which edits the user's own files, Principle 2) reach the next resume.
- **Never copied:** history, sessions, rollouts, transcripts, SQLite state, logs, caches, and logins (the broker owns those).
- **Removed with the worktree** (`worktree-cleanup.ts`), and swept as orphans when no session record owns the folder.
- **Forks copy their source's home** (minus the login), then fork inside the copy, so Codex's `thread/fork` and Claude's `forkSession` find the conversation where they look. A fork of a session on the user's home stays on the user's home.
- **What's loaded** (§12.4) reads the session's effective home.

### 4.2 Which providers, where

| Provider | On the host | In a sandbox | Notes |
|---|---|---|---|
| Codex | **Per-session**, when its login is a file or an API key. With a `keyring` or `auto` store that holds the login in the OS keyring, the user's home plus #278's archiving | Per-session | `CODEX_HOME` moves sessions, state and Codex's own memories, so sessions neither read nor add to the user's. Copy `config.toml` (model, providers, MCP servers, profiles, features), `AGENTS.md`, `prompts/` and user skills |
| Claude Code | **The user's home** | Per-session (`CLAUDE_CONFIG_DIR`) | SDK sessions don't show in `/resume`. The user's `CLAUDE.md`, rules, skills, agents, plugins, hooks, MCP servers in `~/.claude.json` and per-project auto-memory all live there. On macOS the login is in the Keychain. The SDK's own transcript helpers (`forkSession`, `getSessionMessages`, `getSubagentMessages`) find transcripts through the **runner's** `process.env.CLAUDE_CONFIG_DIR`; their `dir` option is the project folder, not the config folder. So isolated Claude homes need those calls in a child process with the session's environment, or a `sessionStore` |
| OpenCode | The user's home | Per-session (its config and data folders) | Sessions are archived already, and each session has a private server |
| Cursor | Decided by #277: per-session if the CLI honours a config-folder variable and leaks | Per-session | No archive or ephemeral option was found |
| Gemini CLI | The user's home | Per-session (`GEMINI_CLI_HOME`) | History is per folder. CodeDen's admin policy files stay in `<data dir>/gemini/` |

A setting, `agents.providerHomes` (`session` by default, or `user`), lets a user who wants CodeDen's Codex threads in their Codex app keep the old behaviour. Principle 6: anything automatic can be switched off.

## 5. Logins: the broker

### 5.1 Sources and hand-over

One broker per runner. On the host, the **source** is the user's own login: a file, the keychain or an environment variable, read when needed and never stored by CodeDen (§6, §14). In a sandbox the source is the copy the server holds in the OS keychain and sends with `runner.credentials` (remote-runners §14).

Hand-over modes, in order of preference for each session:

1. **An environment credential**: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, valid for a year, inference only), `CODEX_API_KEY` / `OPENAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY`. Nothing to refresh and no file. A `setup-token` login can't use claude.ai MCP connectors and doesn't qualify for the SDK's `/usage` report, so plan-usage readings may be missing. Verify this before making it the sandbox default.
2. **Codex external tokens** (§5.3): the session's Codex holds only an access token.
3. **A per-turn file copy**: the login file is copied into the session's home (mode 0600) before each turn and read back while the provider process runs (watch the file) and when the turn ends.

### 5.2 Write-back, and rotating refresh tokens

Several copies of one refresh token are the risk: when one copy refreshes and the provider rotates the refresh token, every other copy, including the user's own CLI, holds a dead one. The rules:

- **Write back promptly.** A changed copy is written back as soon as it changes, not only at turn end: an atomic temp-file-and-rename, under the broker's lock for that provider.
- **Only if newer, only if the source is unchanged.** The broker remembers a hash of the source it copied. If the source changed since (the user's own CLI refreshed), the source wins and the copy is dropped. Newer is read from the file's own fields (Codex `last_refresh`, Claude `expiresAt`).
- **Refresh in one place.** Before handing out a copy close to expiry, the broker refreshes once under the lock. For Codex: `account/read { refreshToken: true }` on a short-lived app-server against the source home. Every session then copies the fresh login.
- **One retry on `auth`.** A turn that fails as `auth` after the source changed since its copy is retried once with a fresh copy.
- **Never logged, never journaled.** Logins travel only in command results that aren't events. Every copy is deleted when its provider process ends. The classifier guards the copies like the originals (§8, issue 1).

### 5.3 Codex external tokens, checked

The installed Codex (0.160.1) app-server has the pieces for a broker that never hands out a refresh token:

- `account/login/start` with `{ type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType? }` (`codex/protocol/v2/LoginAccountParams.ts`);
- a server request `account/chatgptAuthTokens/refresh` (reason `unauthorized`) that the client answers with a new access token (`ServerRequest.ts`, `ChatgptAuthTokensRefreshResponse.ts`);
- `cli_auth_credentials_store = "ephemeral"`, which keeps credentials in memory only (`CliAuthCredentialsStoreMode.ts`, and OpenAI's auth docs);
- `account/read { refreshToken: true }` for a proactive refresh in managed mode (`GetAccountParams.ts`).

**Probe** (an isolated temporary `CODEX_HOME` with `cli_auth_credentials_store = "ephemeral"` and `chatgpt_base_url` pointed at a closed local port, no model call, a fake token):

```text
account/read before   {"account":null,"requiresOpenaiAuth":true,...}
login/start           {"code":-32600,"message":"account/login/start.chatgptAuthTokens requires experimentalApi capability"}
files in CODEX_HOME   .tmp, config.toml, goals_1.sqlite, installation_id, logs_2.sqlite, memories_1.sqlite,
                      queue_1.sqlite, skills, state_5.sqlite (plus -shm/-wal) | auth.json exists: false
```

So external tokens need `experimentalApi: true` at `initialize`, and CodeDen sets `false` today (`codex/process.ts`). A follow-up probe with it on was not run in this spike. Issue 4 (§8) does it behind a test-only flag. If it works, a sandboxed Codex asks for refreshes over the runner link and the home runner's broker answers them, so **the refresh token never enters the sandbox**. Until then, Codex uses mode 3 with write-back, and sandboxes recommend an API key (remote-runners §17.4).

### 5.4 Other things to verify in the issues

- Whether a running Codex app-server re-reads `auth.json` after the broker replaces it between turns, or only after a 401.
- Whether Claude Code with a separate `CLAUDE_CONFIG_DIR` on macOS can use the user's Keychain login. If not, isolated Claude homes on macOS need mode 1.
- Whether Cursor's CLI has a config-folder variable (#277).

## 6. SDK or headless CLI turns, per provider

| Provider | Today | Headless alternative | What the alternative would change |
|---|---|---|---|
| Claude Code | Agent SDK `query()` with streaming input, over the user's `claude` | `claude -p --session-id/--resume` per turn | **Resume:** the same session files. **Fork:** `--fork-session` exists, but without `upToMessageId`. **Subagents:** `stream-json` still tags `parent_tool_use_id`, but the SDK's transcript readers would go. **Permissions:** `canUseTool` and the in-process PreToolUse hook (read-only and plan mode rules) would become an MCP permission tool and settings-file hooks. **Steering:** lost. **Interrupt:** killing the turn's process. **Startup:** a CLI start and MCP reconnect per turn |
| Codex | `codex app-server` | `codex exec --json` per turn | Loses approvals and escalations through the classifier, steering, elicitations, sub-agent threads and `thread/fork` |
| OpenCode | Private `opencode serve` per session | `opencode run` | Loses permission asks, questions and the event stream |
| Cursor, Gemini CLI | ACP | Their print modes | Loses permission requests, plan approval and session load |

**Keep the SDK and the protocol adapters.** Per-session homes need only an environment variable, which every adapter already passes (`claudeEnv` merges `SessionOptions.env`). The Claude-specific costs of an isolated home are the SDK helpers in §4.2, a reason Claude keeps the user's home on the host. `persistSession: false` would break resume and fork. `sessionStore` (alpha in SDK 0.3.318) mirrors transcripts to a store CodeDen owns, an option for surviving a lost sandbox later.

## 7. Migration from A

- **Existing sessions keep the user's home.** A session records its home mode (`Session.providerHome`: `user` or `session`; absent means `user`, contracts and a migration), so sessions started before the change resume where their conversation is until they end. Nothing is moved under a thread.
- **New sessions** get a per-session home where §4.2 says so, once issue 3 ships. Long-lived orchestrator and PM sessions keep the mode they started with, like any other session, and move when a handoff (§9) starts a new one.
- **#278 stays.** Archiving keeps working for sessions on the user's home (legacy sessions, keyring logins, the `user` setting), and the "Hide CodeDen's sessions from the Codex app" clean-up still covers what's already in `~/.codex`.
- **Forks** follow their source (§4.1). **Handoffs** start new sessions, so they get the new mode.
- **Rollback:** setting `agents.providerHomes` to `user` sends new sessions back to the user's homes. Sessions with their own homes keep them until they end.
- **Sandboxes** (phase 4 onwards) always use per-session homes, so they never hit the legacy path.

## 8. Work plan: one pull request each

These are issue drafts for the PM to file once this design is accepted. Issue 1 doesn't depend on the approval in §9.

### 1. Provider login files are secrets (security, needs no approval)

**Title:** `fix(providers): treat provider login files as secrets the risk classifier always asks about`

**Scope.**
- Claude's `.credentials.json` in its config folder, Codex's `auth.json` in `CODEX_HOME`, Gemini CLI's `oauth_creds.json`, OpenCode's `auth.json` in its data folder, and `gh/hosts.yml`.
- Wherever they are, including `<home>/agent-homes/**`.
- Reading, copying, searching, listing by name and writing them ask at every level, Full included, and are refused for read-only sessions, like `CODEDEN_CREDENTIAL_FILES`.
- `attach_evidence` and `share_to_chat` refuse them.
- DESIGN §11.2 and `docs/security.md`.

**Acceptance criteria.**
- [ ] Risk-suite cases for each file and form (`cat`, redirects, `cp`, recursive search, Claude's Read, Grep and Glob).
- [ ] Same-named files that aren't logins (a project's `auth.json` in `src/`) are unaffected.

**Size.** Under 500 lines.

### 2. Login broker

**Title:** `feat(runner): login broker with per-turn hand-over and safe write-back`

**Scope.**
- `ProviderHomeSpec` login entries (contracts, round-trip tests).
- The broker with modes 1 and 3 (§5.1).
- Watch and write back, newer-only, compare-and-swap on the source, a cross-process lock, proactive refresh hook, one `auth` retry.
- No provider uses it yet.

**Acceptance criteria.**
- [ ] Unit tests with fake login files and an injected clock: a refreshed copy is written back; an older copy never overwrites a newer source; a source changed since the copy wins; two sessions refreshing at once leave one valid login; nothing appears in logs or the journal.

**Size.** About 800–1,200 lines. **Depends on:** this design.

### 3. Per-session Codex homes on the host

**Title:** `feat(runner): run Codex sessions with a per-session CODEX_HOME`

**Scope.**
- The provider-home module (§4.1) with Codex's spec.
- Config copy and folder links.
- `Session.providerHome` with a migration.
- Forks copy the source home.
- Cleanup with the worktree, and an orphan sweep.
- `agents.providerHomes` setting.
- Fallback to the user's home for keyring logins.
- The structural fix for #273.

**Acceptance criteria.**
- [ ] With the fake app-server: a new session's threads land in its own home and never in the user's.
- [ ] Resume and fork work, and a legacy session still resumes from the user's home.
- [ ] Archiving the session removes the home.
- [ ] The user's MCP servers and model from `config.toml` apply.

**Size.** About 1,500–2,000 lines. **Depends on:** 2.

### 4. Spike: Codex external tokens

**Title:** `spike(providers): Codex external tokens and an ephemeral credential store behind a test-only flag`

**Scope.**
- `experimentalApi: true` only behind a test-only flag.
- `chatgptAuthTokens` login, answering `account/chatgptAuthTokens/refresh` from the broker.
- `cli_auth_credentials_store = "ephemeral"` in session homes.
- Record which Codex versions support it, and whether the experimental API changes anything else CodeDen relies on.

**Acceptance criteria.**
- [ ] Against a real Codex with a local fake Responses API and a fake token: a turn completes, a forced 401 triggers one refresh request, and no `auth.json` is written.
- [ ] A recommendation recorded in this doc.

**Size.** Under 800 lines. **Depends on:** 2.

### 5. Cursor and the other providers' homes

**Title:** `feat(providers): provider home specs for Claude Code, OpenCode, Cursor and Gemini CLI`

**Scope.**
- Specs for all four, used in sandboxes.
- Cursor on the host only if #277 confirms the leak and a config-folder variable exists.
- Claude's transcript helpers run with the session's environment when its home is isolated.

**Acceptance criteria.**
- [ ] With fake CLIs: each provider in an isolated home starts, resumes and forks (where it can).
- [ ] The host default stays the user's home for Claude Code, OpenCode and Gemini CLI.

**Size.** About 1,000–1,500 lines. **Depends on:** 3.

### 6. Remote runners: amendments to phases 4, 6 and 7

Folded into those phases' issues rather than filed alone:

- **Phase 4 (Docker) and phase 6 (Upstash Box).**
  - Sandbox runners use the provider-home module and the broker.
  - `runner.credentials` delivers the source into broker memory.
  - Refreshed logins come back through a command result that isn't journaled, and are written back on the server's side with the same newer-only rule.
  - The Sandboxes section in Setup offers `claude setup-token` and API keys for Claude.
- **Phase 4 and 6, faster clones.**
  - A bare mirror per project: a named Docker volume, or a folder in the box.
  - Clones with `git clone --reference` (or `--filter=blob:none` partial clones in Upstash), so a new sandbox doesn't fetch the whole history.
- **Phase 7, work that survives losing a sandbox.**
  - Optionally push work in progress to a private ref (`refs/codeden/wip/<session>`) at each checkpoint, besides the checkpoint bundle.
  - It writes to the user's remote, where every reader of the repository can see it, so it **needs the user's decision** (§10).
- **Later.** Several sessions in one sandbox, with slots per box. Per-session homes make it safe; it isn't planned yet.

### 7. Design text

**Title:** `docs: agent execution model in DESIGN.md`

**Scope.** Apply §9 as approved: DESIGN §2, §3, §6, §7.2, §15 and §21, plus `docs/security.md` and `docs/troubleshooting.md`.

**Depends on:** the user's approval. It can land with issue 3.

## 9. Proposed DESIGN.md changes: **Needs the user's approval**

Nothing here is applied to `docs/DESIGN.md` until the user approves it.

**§3 Locked decisions, "Agents" row**, append:

> Each agent session runs its provider's CLI against a **provider home** the runner chooses: the user's own, or a **per-session home** under CodeDen's data folder (`agent-homes/<project>/<session>/<provider>/`) holding a copy of the user's provider config and never their history. On the user's machine, Codex sessions use per-session homes (when its login is a file or an API key), and the other providers use the user's own. In a sandbox every provider does. Logins are handed over per turn by the runner's login broker, which writes refreshed tokens back to their source only when they are newer.

**§3 Locked decisions, "Execution backends" row**, append:

> Containers are never required: local sessions run on the host, and isolation is opt-in per project or session.

**§2 Principle 2**, append:

> A per-session provider home copies the user's config and never replaces it; CodeDen still edits the user's own files.

**§6 Data directory**, add:

> - `agent-homes/<project>/<session>/<provider>/`: per-session provider homes (config copies, the provider's own state and history for that session, and a login copy only while its process runs). Removed with the worktree.

**§7.2 Codex**, add:

> **Home:** each session's app-server runs with `CODEX_HOME` set to its per-session home, so its threads never appear in the user's Codex apps. Sessions from before this change, and logins kept in the OS keyring, use the user's home and are archived when idle.

**§15 Security**, add:

> - **Provider homes are hygiene, not a sandbox.** A per-session home keeps provider state and history apart. The agent still runs as the user; containers are the isolation boundary.
> - **Provider login files** (Claude's `.credentials.json`, Codex's `auth.json`, Gemini CLI's `oauth_creds.json`, OpenCode's `auth.json`, gh's `hosts.yml`, and every copy in `agent-homes/`) ask at every level, like CodeDen's own credential files.

**§21 Risks**, add a row:

> | Refresh tokens rotating across login copies | One broker per runner; copies per turn; prompt, newer-only write-back with compare-and-swap; refresh in one place; external tokens for Codex where available |

## 10. Open questions for the user

1. **Direction.** Approve B (per-session provider homes through one runner module) with containers opt-in (C), and reject D?
2. **Host policy.** Codex per-session on the host (recommended), Claude Code, OpenCode and Gemini CLI on the user's home (recommended), or every provider per-session on the host too?
3. **Codex logins.** A per-turn copy with write-back now and external tokens after the spike (recommended), or API keys only for per-session homes?
4. **Opt-out.** Keep `agents.providerHomes = user` as a setting (recommended), or no switch?
5. **Work-in-progress refs in sandboxes** (§8, issue 6). Push `refs/codeden/wip/<session>` to the user's remote, or rely on checkpoint bundles only (recommended until asked)?

## 11. What was checked

- **Code:** the adapters' environments and homes (§2.1 paths), `agentSessionOptions`, `CODEDEN_CREDENTIAL_FILES` and the risk classifier (`policy/risk.ts`, `policy/paths.ts`), worktree cleanup, and Codex one-shots.
- **Claude Agent SDK 0.3.318**, installed (`sdk.d.ts`): `persistSession`, `sessionStore`, `settingSources`, `forkSession`, `getSessionMessages`, `spawnClaudeCodeProcess`, and the bundled helpers reading `process.env.CLAUDE_CONFIG_DIR`. Claude docs through Context7 (`/websites/code_claude_en_agent-sdk`): isolating tenants with `settingSources`, `CLAUDE_CONFIG_DIR` and `cwd`, and what `setup-token` tokens can't do.
- **Codex 0.160.1:** the generated app-server types in `packages/providers/src/codex/protocol/`, OpenAI's auth and CI/CD auth docs through Context7 (`/llmstxt/learn_chatgpt_llms-full_txt`): credential stores, "one `auth.json` per runner", and refresh about every 8 days.
- **Probes, no model calls, throwaway folders removed afterwards:** the classifier (§2.3); `CLAUDE_CONFIG_DIR=<empty folder> claude auth status` (Claude Code 2.1.325) reports `"loggedIn": false`, so an isolated Claude home needs a login handed over; the Codex external-token probe (§5.3).
- **Issues:** #273 and its reproduction, #277, #278 (open), #232.
