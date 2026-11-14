# Agent execution model: proposal awaiting the user's decision

> Status: **a proposal awaiting the user's decision**, from design spike #274 (2026-11-14). It changes nothing in `docs/DESIGN.md` or in [remote-runners.md](remote-runners.md) until the user decides. §9 holds the DESIGN.md wording it would change; that wording is **not applied**. One item needs no decision: issue 1 in §8 is a security fix within the existing §11.2 rules.

CodeDen runs each agent's own CLI (`claude` through the Agent SDK, `codex app-server`, `opencode serve`, `agent acp`, `gemini --acp`) as the user, on the user's machine, against the user's own provider homes (`~/.claude`, `~/.codex`, …). Remote runners will also run agents in sandboxes: Docker containers, then Upstash Box (remote-runners phases 4–7; phase 2's exec link merged in #268, phase 3a is in #279). This spike asks three things. Should agents keep running on the host, run in containers on the user's machine when the user opts in, or always run in containers? Where should provider homes and logins live, on the host and in a sandbox? And should Claude keep the Agent SDK or move to headless CLI turns?

## 1. Recommendation at a glance

| # | Question | Recommendation | Why, in one line |
|---|---|---|---|
| 1 | Where do agents run by default? | **On the host, as today.** Containers stay opt-in per project or session (remote-runners phases 4–7) | Containers can't build Windows-native projects. They need Docker Desktop on Windows and macOS, and they lose the user's toolchains, logins and native browser views (§3) |
| 2 | Provider homes on the user's machine | **The user's own homes, as today.** #278 already keeps Codex threads out of the Codex app's recents by archiving them | It works now, and the user's memory, skills, plugins, hooks and Keychain logins stay native (§2.2). Per-session homes on the host aren't proposed now (§4.4) |
| 3 | Provider homes in a sandbox | **A per-session home for each provider**, made by one module in the runner (`<runner home>/agent-homes/<project>/<session>/<provider>/`). It holds a copy of the user's config and never their history | A sandbox has no user home. The config and login have to be brought in anyway, and several sessions per sandbox later need them kept apart (§4) |
| 4 | Logins in a sandbox | **A login broker**, per provider. It hands a login over per turn and returns refreshed tokens to their source only when they are newer. Preference order: environment credential, then Codex external tokens, then a per-turn file copy | OAuth refresh tokens can rotate. A copy that refreshes without writing back breaks the user's own CLI (§5) |
| 5 | Codex logins in a sandbox, in the long run | **External tokens** (`chatgptAuthTokens`): the sandboxed Codex holds only an access token and asks for refreshes over the link, so the refresh token never enters the sandbox | Codex's own rule is "one `auth.json` per runner". Probe: it needs Codex's experimental API (§5.3) |
| 6 | SDK or headless CLI turns? | **Keep the Agent SDK and the protocol adapters** (remote-runners decision 1) | Headless turns lose approvals, steering, interrupt, plan mode and live subagents. They gain nothing for provider homes, which work through `env` (§6) |
| 7 | Containers always (option D)? | **No** | It breaks the one-minute first run, offline first use, Windows-native work and the desktop app's native browser (§3.3) |
| 8 | Provider login files | **Secrets to the risk classifier now**, asking at every level | Probe: at Auto, `cat ~/.codex/auth.json` and `cat ~/.claude/.credentials.json` run without asking today (§2.3) |

## 2. Today (option A), as built

### 2.1 How each adapter finds its home and login

Every agent process gets the runner's environment minus CodeDen's own variables (`agentEnv`, `packages/providers/src/util/agent-env.ts`), plus `SessionOptions.env` and `CI=true` (`agentSessionOptions`, `apps/runner/src/session-env.ts`). Nothing sets a provider home, so each CLI uses the user's own.

| Provider | Home, and what moves it | Login | History CodeDen's sessions write |
|---|---|---|---|
| Claude Code | `~/.claude` and `~/.claude.json`; `CLAUDE_CONFIG_DIR` moves both (`claudeHomes`, `claude/session.ts`) | `.credentials.json` in the config folder on Windows and Linux, the Keychain on macOS, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | `projects/<encoded cwd>/<session>.jsonl`, one folder per worktree path. SDK sessions stay out of `/resume`, with `CLAUDE_CODE_ENTRYPOINT=sdk-ts` pinned in `claudeEnv` (#278) |
| Codex | `$CODEX_HOME`, default `~/.codex` | `auth.json` or the OS keyring (`cli_auth_credentials_store`: `file`, `keyring`, `auto`, `ephemeral`), or `CODEX_API_KEY` / `OPENAI_API_KEY` | Rollouts in `sessions/…` plus SQLite state. Since #278, each thread is archived when no turn runs and unarchived before the next turn, resume or fork (`codex/thread-open.ts`, `codex/history.ts`). Settings has a clean-up for older threads |
| OpenCode | Its own config and data folders; CodeDen layers `OPENCODE_CONFIG_CONTENT` on top (`opencode/server.ts`) | Its own `auth.json` per connected provider, or provider keys in the environment | Its own database. CodeDen archives each session on create and on resume (`opencode/session.ts`) |
| Cursor | `~/.cursor` | `agent login`, or `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | Chats are likely listed across workspaces by `agent ls` and `/resume` (#277, unverified) |
| Gemini CLI | `~/.gemini`; `GEMINI_CLI_HOME` moves it (`gemini/auth.ts`) | `oauth_creds.json` or the system keychain, or `GEMINI_API_KEY` and the other login variables | Per project folder; worktrees are separate folders |

One-shot jobs (the utility model, image generation through Codex) start Codex threads with `ephemeral: true` (`codex/one-shot.ts`, `image/codex-turn.ts`), so they leave no history.

### 2.2 What sharing the user's homes still costs

None of these needs per-session homes on the host now:

- **Archived threads.** CodeDen's Codex threads are archived, so they appear in the Codex app's archived list rather than its recents. Cursor is open (#277).
- **Disk.** Removing a worktree leaves the provider's own transcripts behind (`~/.claude/projects/<worktree path>/`, `~/.codex/sessions/…`). A later clean-up could delete a session's transcripts when CodeDen deletes the session.
- **Config shared both ways.** A change to a provider's user config reaches the user and every session at once. An agent's own edits there are writes outside the worktree, so they ask at every level (§11.2). One approval still reaches every later session.
- **One login, shared by everyone.** Every session and the user's own CLI share one login file. It works because each CLI refreshes and re-reads the same file.

### 2.3 Finding: provider login files are not secrets to the classifier

Checked with the classifier itself (`classifyCommand` and `classifyRead` in `packages/providers/src/policy/risk.ts`, worktree `/work/repo`):

```text
cat ~/.codex/auth.json            {"risky":false}
cat ~/.claude/.credentials.json   {"risky":false}
read /home/me/.codex/auth.json    {"risky":false}
cat ~/.ssh/id_ed25519             {"risky":true,"action":"secrets",...}
cat .env                          {"risky":true,"action":"secrets",...}
```

`isSecretPath` (`policy/paths.ts`) knows `.env`, SSH keys, `.npmrc`, `credentials.json`, and the `.ssh`, `.aws`, `.gnupg` and `.docker` folders. It doesn't know Claude's `.credentials.json`, Codex's `auth.json`, Gemini CLI's `oauth_creds.json`, OpenCode's `auth.json` or gh's `hosts.yml`.

So a prompt-injected agent at Auto can read the user's subscription logins into its context without asking. Only the level's network rules then stand between them and an outside host, and Full allows the network. This holds in every option below, so it is fixed first and on its own (§8, issue 1). The agent's own CLI never needs a tool call to read its login, so asking at every level costs nothing in normal work, the same as for CodeDen's own credential files.

## 3. The options compared

- **A. Today.** A host runner, adapters over each CLI's protocol, the user's own provider homes (plus #278's archiving).
- **B. Per-session provider homes on any runner**, with logins brokered per turn.
- **C. B, plus an optional container per session** on the user's machine: the `docker` backend, remote-runners phase 4.
- **D. Containers always**, even for local sessions.

### 3.1 Summary

| | A. Today | B. Per-session homes | C. B + opt-in container | D. Containers always |
|---|---|---|---|---|
| Isolation from the user's files | None: the agent is the user | None at the OS level. Sessions don't share provider state, and an approved edit to an agent's provider config stays in its own session | A container per session that opts in: no access to the user's home, SSH keys or other projects | The same, for every session |
| Prompt-injection blast radius | The user's account | The user's account | The container, plus whatever its login and GitHub credential reach | The same as C |
| Allow-list bypass (#232) | Guarded by the classifier | The same | The same; a file written in the container still lands in the repository through a PR | The same as C |
| History in the user's apps | Codex archived when idle (#278); Cursor likely (#277) | None for providers with their own home | None | None |
| User's config (memory, skills, MCP, hooks) | Native, live | Copied in at session open | Copied in; macOS Keychain logins and Windows paths in the config don't carry over | The same as C, always |
| Credentials | Each CLI's own | Broker, per turn, with write-back | Broker over the link (remote-runners §14) | Always over the link |
| Windows and macOS | Native | Native | Needs Docker Desktop (a paid subscription in larger companies) or Docker Engine; Linux containers only | Required for everyone |
| Startup, disk, RAM | A worktree per session | Plus a small home folder per session (a new Codex home holds five SQLite databases) | Plus an image (about 1.94 GB in the remote-runners spike), a clone per session, and the Docker VM's RAM | The same as C, for every session |
| Offline | Works (model calls aside; local models through OpenCode work) | Works | Works once the image is built | First run needs the network for the image |
| `npx codeden` and desktop first run | Under a minute (§14) | Unchanged | Unchanged until a project opts in | Install Docker, then build an image |
| Browser | The runner's Chromium, and native views in the desktop app | The same | Chromium in the container, screencast only (remote-runners §12) | Screencast only, always |
| Terminals | node-pty on the host | The same | node-pty in the container, over the link | The same as C |
| Computer use | Browser pointer actions | The same | The same, plus a later virtual desktop in the image (dedicated agent computers) | The same as C |
| Windows-native projects (.NET, PowerShell, MSBuild) | Yes | Yes | No | No |

### 3.2 Notes on the hard rows

- **B is hygiene, not a sandbox.** A per-session home keeps provider state apart. The agent still runs as the user and can read anything the user can. The real boundaries are the risk classifier (§11.2), the provider's own sandbox (Codex) and a container (C). Docs that describe B must say so plainly.
- **Prompt injection in C.** Inside a container the agent can still read its own login, because the provider process needs it. Codex external tokens (§5.3) and the inference-only `claude setup-token` token narrow what a stolen login is worth. The brokered GitHub credential (remote-runners §9.2) keeps the user's GitHub token out of the sandbox between git operations.
- **Docker Desktop reaches the host's loopback** (remote-runners §7). The install token and MCP session tokens are the boundary, not the bind address, and C keeps that rule.
- **The user's config in a container.** A Linux container can't use a macOS Keychain login, Windows paths in `config.toml`, MCP servers that run host programs, or the user's SDKs and databases. That is fine for an opt-in backend that clones GitHub projects. It would be a regression as the default.

### 3.3 Why not D

D makes every user install Docker before their first session and build or download an image of about 2 GB. That breaks the one-minute first run (§14) and offline first use. On Windows and macOS it adds a Linux VM that holds several GB of RAM. It can't build Windows-native projects, and it gives up the desktop app's native browser views and the user's own toolchains. Its gain over C is isolation for users who didn't ask for it, and C already offers that per project and per session, at a cost the user chooses.

## 4. Per-session provider homes, for sandboxed runners

### 4.1 Why a sandbox needs them

- **There is no user home in a sandbox.** The provider CLIs baked into the image find empty homes. The user's config (model, MCP servers, memory, skills) has to be copied in, and the login handed over.
- **File-only logins need a file.** Remote-runners §14 holds credentials in runner memory and passes them as environment variables. That works for API keys and `CLAUDE_CODE_OAUTH_TOKEN`, but a Codex subscription login (`auth.json`) and OpenCode's OAuth logins are files the CLI reads, and refreshes, in its home.
- **Several sessions per sandbox, later.** Remote-runners places one session per sandbox; a warm pool, or several sessions per box limited by slots, is a later optimisation. Per-session homes keep their transcripts, config edits and logins apart when that comes.
- **Clean-up.** A session's home goes with its workspace, so a long-lived sandbox doesn't fill up.

### 4.2 One module in the runner

- **Each adapter describes its home** in a `ProviderHomeSpec` (contracts first). It names the environment variable that moves the home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, OpenCode's config and data folders, Cursor's to be found in #277). It lists which entries are **config** to copy in and which are the **login**, handed over by the broker (§5). Everything else is **state** that stays per session. The UI and orchestration read the spec as a capability, never a provider id.
- **The runner prepares the home** when a session opens (start or resume), next to `agentSessionOptions`, and adds the variable to the session's `env`. The home is `<runner home>/agent-homes/<project>/<session>/<provider>/`, which mirrors `wt/<project>/<session>/`.
- **Where the config comes from.** In a sandbox, the server sends the user's provider config over the link, as files with paths relative to the home. It sends them the same way it will send logins (`runner.credentials`, remote-runners §14), but config is not secret. The runner refreshes the copy every time the session opens, so edits the user makes on the Agents page (to their own files, Principle 2) reach the next resume. Paths that only make sense on the user's machine (Windows paths, MCP servers that run host programs) are dropped with a notice.
- **Never copied:** history, sessions, rollouts, transcripts, SQLite state, logs, caches, and logins (the broker owns those).
- **Removed with the workspace** (`worktree-cleanup.ts` and the sandbox's own clean-up, remote-runners §16), and swept as an orphan when no session record owns the folder.
- **Forks copy their source's home** (minus the login) on the same runner, then fork inside the copy. That way Codex's `thread/fork` and Claude's `forkSession` find the conversation where they look. A fork already stays on its source's runner (remote-runners §8).
- **What's loaded** (§12.4) reads the session's effective home.

### 4.3 Per provider, in a sandbox

| Provider | Variable | Config copied in | Login (§5.1) | Notes |
|---|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | `settings.json`, `CLAUDE.md`, `rules/`, `skills/`, `agents/`, `commands/`, user MCP servers from `~/.claude.json` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; a `.credentials.json` copy only where the user's login is a file (Windows, Linux) | The SDK's transcript helpers (`forkSession`, `getSessionMessages`, `getSubagentMessages`) find transcripts through the **runner's** `process.env.CLAUDE_CONFIG_DIR`. Their `dir` option is the project folder, not the config folder. So they need a child process with the session's environment, or a `sessionStore` |
| Codex | `CODEX_HOME` | `config.toml` (model, providers, MCP servers, profiles, features), `AGENTS.md`, `prompts/`, user skills | External tokens (§5.3), else an `auth.json` copy, else `CODEX_API_KEY` | A new home also gets new SQLite state and Codex's own memories. The session neither reads nor adds to the user's |
| OpenCode | its config and data folders | `opencode.json` and its agents and commands | Provider keys in the environment, else an `auth.json` copy | CodeDen's inline config still layers on top |
| Cursor | to be found (#277) | `cli-config.json` without permission rules | `CURSOR_API_KEY` | Without a variable that moves its home, a sandbox session uses the image's empty home and the key |
| Gemini CLI | `GEMINI_CLI_HOME` | `settings.json` (auth type, MCP servers), `GEMINI.md`, policies | `GEMINI_API_KEY`, else an `oauth_creds.json` copy | CodeDen's admin policy files stay in the runner's `gemini/` folder |

Copying an agent's allow-list files into a sandbox follows §11.2: rules the user wrote come with the config, and the start warning still applies.

### 4.4 Per-session homes on the user's machine: not now

The same module could give host sessions their own homes. Today that would buy:
- no CodeDen threads in Codex's archived list;
- provider transcripts removed with the worktree;
- config edits kept to one session.

It would cost:
- Claude's transcript helpers would have to run with each session's environment (§4.3);
- macOS Keychain logins can't follow a moved Claude config folder (unverified, §5.4);
- the user's live config would become copies refreshed at session open;
- a broker would be running on the host.

#278 already handles the leak that mattered. So the host keeps the user's homes. The case to revisit is Cursor: if #277 finds no way to archive or hide its chats, a per-session home for Cursor sessions on the host may be the only fix.

## 5. Logins: the broker

### 5.1 Sources and hand-over

One broker per runner.
- **For a sandboxed session, the source is on the server's machine.** It is the user's own login file there when the login is a file (Principle 3: inherit, don't re-ask). Otherwise it is a credential CodeDen holds in the OS keychain: an API key, or a `claude setup-token` token.
- The server reads the source when a session needs it and sends it with `runner.credentials` (remote-runners §14). It is never written into an image, a snapshot or a container's configuration.

Hand-over modes, in order of preference for each session:

1. **An environment credential:** `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`: valid for a year, inference only), `CODEX_API_KEY` / `OPENAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY`. There is nothing to refresh and no file.
   - A `setup-token` login can't use claude.ai MCP connectors and doesn't qualify for the SDK's `/usage` report, so plan-usage readings may be missing. Verify this before making it the sandbox default for Claude.
2. **Codex external tokens** (§5.3): the sandboxed Codex holds only an access token.
3. **A per-turn file copy:** the login file is written into the session's home (mode 0600) before each turn. The runner watches it while the provider process runs and reads it back when the turn ends.

### 5.2 Write-back, and rotating refresh tokens

The risk is several copies of one refresh token. When one copy refreshes and the provider rotates the refresh token, every other copy holds a dead one, including the user's own CLI. The rules:

- **Return changes promptly.** A changed copy goes back to the server as soon as it changes, not only at turn end. It travels in a command result that is never journaled or logged.
- **Keep it only if it is newer and the source hasn't changed.** The server remembers a hash of the source it sent. If the source changed since (the user's own CLI refreshed), the source wins and the returned copy is dropped. Otherwise the copy is written to the source atomically (temp file and rename). Which login is newer comes from the file's own fields (Codex `last_refresh`, Claude `expiresAt`).
- **Refresh in one place.** Before sending a login that is close to expiry, the server's side refreshes it once. For Codex that is `account/read { refreshToken: true }` on a short-lived app-server against the source home. Every session then gets the fresh login.
- **Retry once on `auth`.** A turn that fails as `auth` after the source changed since its copy is retried once, with a fresh copy.
- **Delete copies and guard them.** Every copy is deleted when its provider process ends, and the classifier guards copies like the originals (§8, issue 1).

### 5.3 Codex external tokens, checked

The installed Codex (0.160.1) app-server has the pieces for a broker that never hands out a refresh token:

- `account/login/start` with `{ type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType? }` (`codex/protocol/v2/LoginAccountParams.ts`);
- a server request, `account/chatgptAuthTokens/refresh` (reason `unauthorized`), which the client answers with a new access token (`ServerRequest.ts`, `ChatgptAuthTokensRefreshResponse.ts`);
- `cli_auth_credentials_store = "ephemeral"`, which keeps credentials in memory only (`CliAuthCredentialsStoreMode.ts`, and OpenAI's auth docs);
- `account/read { refreshToken: true }` for a proactive refresh in managed mode (`GetAccountParams.ts`).

**Probe.** The setup:
- an isolated temporary `CODEX_HOME` with `cli_auth_credentials_store = "ephemeral"`;
- `chatgpt_base_url` pointed at a closed local port;
- a fake token, and no model call.

```text
account/read before   {"account":null,"requiresOpenaiAuth":true,...}
login/start           {"code":-32600,"message":"account/login/start.chatgptAuthTokens requires experimentalApi capability"}
files in CODEX_HOME   .tmp, config.toml, goals_1.sqlite, installation_id, logs_2.sqlite, memories_1.sqlite,
                      queue_1.sqlite, skills, state_5.sqlite (plus -shm/-wal) | auth.json exists: false
```

So external tokens need `experimentalApi: true` at `initialize`, and CodeDen sends `false` today (`codex/process.ts`). A second probe with it on was not run in this spike; issue 4 (§8) runs it behind a test-only flag.

If it works, a sandboxed Codex sends its refresh requests over the runner link, and the server's side answers them from the source. **The refresh token never enters the sandbox.** Until then, a sandboxed Codex uses mode 3 with write-back, or an API key (remote-runners §17.4).

### 5.4 Still to verify

These are checked in the issues:
- Whether a running Codex app-server re-reads `auth.json` after the broker replaces it between turns, or only after a 401.
- Whether Claude Code on macOS can use the user's Keychain login with a separate `CLAUDE_CONFIG_DIR`. This only matters for a host option (§4.4); sandboxes don't use the Keychain.
- Whether Cursor's CLI has a variable that moves its home (#277).

## 6. SDK or headless CLI turns, per provider

| Provider | Today | Headless alternative | What the alternative would change |
|---|---|---|---|
| Claude Code | Agent SDK `query()` with streaming input, over the user's `claude` | `claude -p --session-id/--resume` per turn | **Resume:** the same session files. **Fork:** `--fork-session` exists, but without `upToMessageId`. **Subagents:** `stream-json` still tags `parent_tool_use_id`, but the SDK's transcript readers are gone. **Permissions:** `canUseTool` and the in-process PreToolUse hook (read-only and plan-mode rules) become `--permission-prompt-tool` and hooks in a settings file. **Steering:** lost. **Interrupt:** killing the turn's process. **Startup:** the CLI starts and MCP reconnects on every turn |
| Codex | `codex app-server` | `codex exec --json` per turn | Loses approvals and escalations through the classifier, steering, elicitations, sub-agent threads and `thread/fork` |
| OpenCode | A private `opencode serve` per session | `opencode run` | Loses permission asks, questions and the event stream |
| Cursor, Gemini CLI | ACP | Their print modes | Lose permission requests, plan approval and session load |

**Keep the SDK and the protocol adapters.** A provider home needs only an environment variable, which every adapter already passes (`claudeEnv` merges `SessionOptions.env`). The only Claude-specific cost is the SDK helpers in §4.3. `persistSession: false` would break resume and fork. `sessionStore` (alpha in SDK 0.3.318) mirrors transcripts to a store CodeDen owns. That is a later option so a conversation can survive a lost sandbox (remote-runners phase 7).

## 7. Migration from A

- **Host sessions: nothing changes.** Existing and new local sessions keep the user's homes, and #278's archiving and clean-up stay as they are.
- **Sandboxed sessions are new** (phase 4 onwards), so they start with per-session homes and there is no legacy to move.
- **Each session records its home mode.** `Session.providerHome` is `user` (also when absent) or `session`, in contracts with a migration. Resume, fork and a future host option then know where a conversation lives without guessing from the runner.
- **Sessions don't move between runners** (remote-runners §8). To continue a local conversation in a sandbox, a handoff starts a new session there with a brief. It doesn't copy provider transcripts across.
- **A lost sandbox** is recreated from the pushed branch or a checkpoint bundle (phase 7). Its provider conversation is lost unless `sessionStore` mirrors it, which is a later option.

## 8. Work plan: one pull request each

These are issue drafts for the PM to file once the user decides. Issue 1 doesn't wait for that decision.

### 1. Provider login files are secrets (security, needs no decision)

**Title:** `fix(providers): treat provider login files as secrets the risk classifier always asks about`

**Scope.**
- The files: Claude's `.credentials.json` in its config folder, Codex's `auth.json` in `CODEX_HOME`, Gemini CLI's `oauth_creds.json`, OpenCode's `auth.json` in its data folder, and gh's `hosts.yml`, wherever they are, including `agent-homes/**`.
- Reading, copying, searching, listing by name or writing one asks at every level, Full included, and is refused for read-only sessions, like `CODEDEN_CREDENTIAL_FILES`.
- `attach_evidence` and `share_to_chat` refuse them.
- Docs: DESIGN §11.2 and `docs/security.md`.

**Acceptance criteria.**
- [ ] Risk-suite cases for each file and form (`cat`, redirects, `cp`, recursive search, Claude's Read, Grep and Glob).
- [ ] Same-named files that aren't logins (a project's `src/auth.json`) are unaffected.

**Size.** Under 500 lines.

### 2. Provider home specs and the provider-home module

**Title:** `feat(runner): per-session provider homes for runners in sandboxes`

**Scope.**
- `ProviderHomeSpec` per adapter, in contracts with round-trip tests.
- The runner module (§4.2), used when the runner's `welcome.backend` isn't `local`.
- Config files sent over the link.
- `Session.providerHome` with a migration.
- Forks copy their source's home.
- Clean-up with the workspace, and an orphan sweep.

**Acceptance criteria.**
- [ ] With a test runner whose home is a different folder from the server's (as in phase 3's tests), Fake-provider sessions get their own homes with the copied config. Resume and fork work, and removing the workspace removes the home.
- [ ] Local sessions are unchanged.

**Size.** About 1,500–2,000 lines. **Depends on:** the user's decision, and phase 3a (#279).

### 3. Login broker

**Title:** `feat: login broker with per-turn hand-over and newer-only write-back over the runner link`

**Scope.**
- Hand-over modes 1 and 3 (§5.1).
- Write-back as in §5.2: return copies in command results that aren't journaled; compare and swap on the source; refresh in one place; one retry on `auth`.
- The Sandboxes section in Setup offers `claude setup-token` and API keys.

**Acceptance criteria.**
- [ ] Unit tests with fake login files and an injected clock:
  - a refreshed copy is written back;
  - an older copy never overwrites a newer source;
  - a source changed since the copy wins;
  - two sessions refreshing at once leave one valid login.
- [ ] No login appears in logs, the journal or events (the test greps them).

**Size.** About 1,000–1,500 lines. **Depends on:** 2. It is part of what phase 4's credential delivery needs.

### 4. Spike: Codex external tokens

**Title:** `spike(providers): Codex external tokens and an ephemeral credential store behind a test-only flag`

**Scope.**
- `experimentalApi: true`, only behind a test-only flag.
- A `chatgptAuthTokens` login, with `account/chatgptAuthTokens/refresh` answered by the broker.
- `cli_auth_credentials_store = "ephemeral"` in session homes.
- Record which Codex versions support it, and whether the experimental API changes anything else CodeDen relies on.

**Acceptance criteria.**
- [ ] Against a real Codex with a local fake Responses API and a fake token:
  - a turn completes;
  - a forced 401 triggers exactly one refresh request;
  - no `auth.json` is written.
- [ ] The recommendation is recorded in this document.

**Size.** Under 800 lines. **Depends on:** 3.

### 5. Amendments to remote-runners phases 4, 6 and 7

These fold into those phases' issues rather than being filed on their own.

- **Phases 4 and 6:**
  - Sandbox runners use the provider-home module and the broker.
  - `runner.credentials` carries the source into broker memory.
- **Phases 4 and 6, faster clones:**
  - Keep a bare mirror per project: a named Docker volume, or a folder in the box.
  - Clone with `git clone --reference`, or with `--filter=blob:none` partial clones in Upstash, so a new sandbox doesn't fetch the whole history.
- **Phase 7, work that survives a lost sandbox:**
  - Optionally push work in progress to a private ref (`refs/codeden/wip/<session>`) at each checkpoint, besides the checkpoint bundle.
  - This writes to the user's remote, where every reader of the repository can see it. So it **needs the user's decision** (§10).
- **Later:** several sessions in one sandbox, with slots per box. Per-session homes make that safe; it isn't planned yet.

### 6. Later, only if asked: per-session homes on the host

**Title:** `feat(runner): optional per-session provider homes for local sessions`

**Scope.** §4.4's option, behind a setting. Cursor goes first if #277 finds no other fix.

**Depends on:** 2 and 3, and a request.

### 7. Design text

**Title:** `docs: agent execution model in DESIGN.md`

**Scope.** Apply §9 as the user decides. **Depends on:** the decision. It can land with issue 2.

## 9. Proposed DESIGN.md changes (not applied)

Nothing in this section is in `docs/DESIGN.md`. It is the wording this proposal would add once the user decides.

**§3 Locked decisions, "Agents" row**, append:

> On the user's machine, sessions use the user's own provider homes. In a sandbox, each session runs its provider's CLI against a **per-session provider home** in the sandbox runner's home. That home holds a copy of the user's provider config, never their history. The runner's **login broker** hands logins over per turn and returns refreshed tokens to their source only when they are newer.

**§3 Locked decisions, "Execution backends" row**, append:

> Containers are never required: local sessions run on the host, and isolation is opt-in per project or session.

**§2 Principle 2**, append:

> A per-session provider home in a sandbox copies the user's config and never replaces it. CodeDen still edits the user's own files.

**§4.2 Runner, "Remote runners" bullet**, append:

> Inside a sandbox, every session gets its own provider homes ([agent-execution.md](agent-execution.md)), and logins arrive per turn through the login broker.

**§15 Security**, add:

> - **Provider homes are hygiene, not a sandbox.** A per-session home keeps provider state and history apart. The agent still runs as its runner's user, and containers are the isolation boundary.
> - **Provider login files** ask at every level, like CodeDen's own credential files. They are Claude's `.credentials.json`, Codex's `auth.json`, Gemini CLI's `oauth_creds.json`, OpenCode's `auth.json`, gh's `hosts.yml`, and every copy in `agent-homes/`.

**§21 Risks**, add a row:

> | Refresh tokens rotating across login copies | One broker per runner; copies per turn; prompt, newer-only write-back with compare-and-swap on the source; refresh in one place; Codex external tokens where available |

## 10. Open questions for the user

1. **Direction.** Per-session provider homes and the login broker for sandboxed runners (B), containers opt-in (C), and no D?
2. **The host.** Keep the user's homes plus #278's archiving (recommended), or offer per-session homes on the host too (§4.4)?
3. **Codex in sandboxes.**
   - A per-turn `auth.json` copy written back to the user's own login, now, with external tokens after the spike (recommended)?
   - Or API keys only (remote-runners §17.4)?
4. **Claude in sandboxes.** Which login by default?
   - a `claude setup-token` token (recommended once plan-usage readings are checked);
   - an API key;
   - or a copy of `.credentials.json` where the login is a file?
5. **Work-in-progress refs.** Push `refs/codeden/wip/<session>` to the user's remote from sandboxes, or rely on checkpoint bundles only (recommended until asked)?

## 11. What was checked

- **Code:**
  - the adapters' environments and homes (the paths in §2.1);
  - `agentSessionOptions`;
  - `CODEDEN_CREDENTIAL_FILES` and the risk classifier (`policy/risk.ts`, `policy/paths.ts`);
  - worktree clean-up;
  - Codex one-shots;
  - the merged #278 (`codex/thread-open.ts`, `codex/history.ts`, `CLAUDE_CODE_ENTRYPOINT` in `claudeEnv`).
- **Claude Agent SDK 0.3.318,** installed (`sdk.d.ts`):
  - `persistSession`, `sessionStore`, `settingSources`, `forkSession`, `getSessionMessages` and `spawnClaudeCodeProcess`;
  - the bundled helpers that read `process.env.CLAUDE_CONFIG_DIR`.
- **Claude docs** through Context7 (`/websites/code_claude_en_agent-sdk`): isolating tenants with `settingSources`, `CLAUDE_CONFIG_DIR` and `cwd`, and what `setup-token` tokens can't do.
- **Codex 0.160.1:**
  - the generated app-server types in `packages/providers/src/codex/protocol/`;
  - OpenAI's auth and CI/CD auth docs through Context7 (`/llmstxt/learn_chatgpt_llms-full_txt`): the credential stores, "one `auth.json` per runner", and a refresh about every 8 days.
- **Probes,** with no model calls, in throwaway folders removed afterwards:
  - the classifier (§2.3);
  - `CLAUDE_CONFIG_DIR=<empty folder> claude auth status` (Claude Code 2.1.325) reports `"loggedIn": false`, so a per-session Claude home needs a login handed over;
  - the Codex external-token probe (§5.3).
- **Issues and pull requests:** #273 and #278 (merged), #277, #232, #268 (phase 2, merged), #279 (phase 3a, open).
