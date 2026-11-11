# CodeDen: Design

> Status: **locked for v1**, 2026-11-07. Changes to anything in "Locked decisions" need an explicit design discussion and an update to this file. The desktop app (§17) was approved on 2026-11-08. Opt-in network access for phones and tablets (§15.1) was approved on 2026-11-08. The software factory and dark factory redesign (§10.1) was approved on 2026-11-11.

## 1. What CodeDen is

CodeDen is a local-first harness for coding agents (Claude Code and Codex at launch, more later). Lead with this: a beautiful, streamlined coding harness that can also run a software factory, and a dark factory that finds its own work. Every piece of work stays visible and traceable in GitHub.

- **Orchestrator.** One high-level agent you talk to. It creates projects and hands work to project managers.
- **Project Managers (PMs).** One long-lived agent per project. It triages GitHub issues, starts agent sessions, follows their progress, and escalates to you when unsure.
- **Agent sessions.** Coding agents, each in its own git worktree and branch. They open pull requests, attach test evidence, and ask you questions.
- **Inbox.** One place for everything waiting on you: questions, approvals, PRs ready for review, failed runs, triage decisions.
- **Automations.** Toggleable background work such as security audits, refactor sweeps, dependency updates, UI reviews and issue triage. Ships with templates; users add their own.
- **Workbench.** An integrated terminal, a browser the agents can drive, diffs, files, and first-class editing of agent memory files, skills, subagents and MCP servers.
- **Voice.** Dictation into the composer, and read-aloud of an agent's final message.
- **Image generation for every agent.** A Claude agent can create images too. One `generate_image` tool routes to whichever engine you chose in Settings (Codex, Gemini, OpenAI).
- **Follow-up prompts.** When an agent finishes, CodeDen suggests the next prompts as one-click chips.

Installed with `npx codeden`, or as the desktop app (§17). Open source under the MIT license. No accounts, no license checks, no hosted backend.

## 2. Principles

1. **Visible, not magic.** Every agent action is an event you can see, replay and trace to an issue, branch or PR. Nothing important happens off-screen.
2. **Native files are the source of truth.** CodeDen reads and writes each provider's own config (`CLAUDE.md`, `AGENTS.md`, skills, subagents, `.mcp.json`, `~/.codex/config.toml`) instead of keeping a private copy. Edits in CodeDen show up in the terminal CLI, and the other way round.
3. **Inherit, don't re-ask.** Existing Claude Code, Codex, GitHub and git setups are detected and reused. CodeDen never asks for a credential it can already use.
4. **SDKs and protocols, never scraped CLI output.**
5. **Honest capabilities.** Each provider declares what it supports. The UI and orchestration read those flags and never branch on a provider's name, and never pretend to enforce something the provider can't.
6. **Everything automatic can be switched off.** Automations, triage, auto-PRs and read-aloud are all opt-in or toggleable, globally and per project.
7. **Lean.** Plain TypeScript, few packages, few native dependencies, small modules. Most code will be written by coding agents, so mainstream patterns beat clever ones.
8. **Survive restarts.** Agents keep working when the server restarts. Every session can be resumed.

## 3. Locked decisions

| Area | Decision |
|---|---|
| Distribution | Two ways, one codebase and one data folder: `npx codeden` starts a local server and opens the browser; the **desktop app** (Electron, §17) starts or attaches to the same server and loads the same UI, installed from GitHub Releases (NSIS, dmg/zip, AppImage/deb) and updated by electron-updater |
| License / business | Fully open source (MIT). No accounts or license gating |
| Language | Plain TypeScript (strict), ESM. No Effect |
| Runtime | Node.js **24+** |
| Repo | pnpm workspace, about five packages (§5), published as one `codeden` npm package |
| Server | Hono on `@hono/node-server`, with WebSockets via `@hono/node-ws` |
| Database | SQLite through the built-in `node:sqlite` and Drizzle (`drizzle-orm/node-sqlite`), WAL mode |
| Web UI | React 19 + Vite single-page app; Tailwind v4 + shadcn/ui; TanStack Router + TanStack Query; Zustand. **Not Next.js** |
| API typing | Hono typed RPC client for HTTP; shared zod schemas for the WebSocket event model |
| Agents | Claude Code through the **Claude Agent SDK**, using the user's installed `claude` binary. Codex through **`codex app-server`** (JSON-RPC, with types generated from the installed Codex). OpenCode (official SDK) and a generic **ACP** adapter come after v1 |
| Agent ↔ app | One internal **MCP server** (Streamable HTTP) with **role-scoped tokens** (orchestrator, PM, agent) |
| Process model | **Server and runner are separate processes** from day one (§4) |
| Terminal | node-pty in the runner, xterm.js in the UI |
| Default autonomy | **Auto, risky actions ask** (§11.2). Overridable per project and per session |
| Image generation | A pluggable `generate_image` tool available to every agent. Engines: Codex (the default when Codex is logged in), Gemini image models, OpenAI Images. Chosen in Settings (§12.5) |
| Utility model | One small, cheap model setting for side jobs: follow-up suggestions, read-aloud summaries, session titles (§7.4) |
| v1 scope | The full vision: daily driver, orchestration, automations (§19) |
| Projects | GitHub repos get the full issue/PR/evidence flow. **Local-only folders are supported** without the GitHub features |
| Forges | GitHub only in v1 |
| Platforms | Windows, macOS and Linux. **Windows is tested first** |
| Network exposure | The runner, its MCP proxy and the server's `/mcp` listen on or answer **127.0.0.1 only**, always. The server's web UI, HTTP API and UI WebSockets are 127.0.0.1 only **by default**; **opt-in network access** (decided 2026-11-08, §15.1) moves just that HTTP listener to `0.0.0.0` on the same port, behind a password sign-in, for phones and tablets on the LAN or the user's own VPN |
| Tooling | Biome (lint and format), tsdown (bundling), Vitest, Playwright (end-to-end) |

## 4. Architecture

```
┌──────────────────────── Web UI (React SPA) ─────────────────────────┐
│ sidebar · chat · inbox · right panels (diff/files/browser/terminal) │
└───────────────┬──────────────────────────────────────▲──────────────┘
                │ HTTP (Hono RPC) + WebSocket          │ live events (seq)
┌───────────────▼──────────────────────────────────────┴──────────────┐
│ SERVER  (long-lived, owns state)                                    │
│  SQLite event log + projections · orchestration (orchestrator, PMs) │
│  MCP endpoint /mcp (role-scoped) · scheduler · GitHub sync          │
│  inbox · settings · first-run setup · static UI hosting             │
└───────────────┬──────────────────────────────────────▲──────────────┘
                │ runner protocol over WebSocket        │ events + acks
┌───────────────▼──────────────────────────────────────┴──────────────┐
│ RUNNER  (next to the code; local process now, remote box later)     │
│  provider adapters (Claude SDK, Codex app-server, …) · node-pty     │
│  Chromium/CDP · worktree + git ops · local MCP proxy · event journal│
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Server

The server is the single owner of persistent state. It never starts agent processes itself. It:

- serves the UI;
- holds the database;
- runs the orchestrator and PM logic;
- hosts the MCP endpoint;
- schedules automations;
- syncs GitHub;
- talks to one or more runners.

It's started through a single `startServer({ port, dataDir, token })` function and never imports anything platform-specific. That keeps the Electron path open.

### 4.2 Runner

The runner hosts everything that has to sit next to the code: agent processes (through provider adapters), terminals, the browser, and worktree and git operations.

- **Local today.** It's a separate, detached process that the server starts on demand. It's found again through a lock file in the data directory holding its port, token, PID and version.
- **Survives server restarts.** A server restart (crash, update, dev reload) doesn't touch running agents. The server reconnects and catches up.
- **Event journal.** The runner keeps events locally until the server acknowledges them by sequence number, so nothing is lost while the server is away.
- **Upgrades.** On a version mismatch, the runner drains. It finishes or pauses turns, then restarts. Sessions are resumed through their provider's resume support, with an automatic "you were interrupted, continue" message when a turn was cut off.
- **Remote later.** The same runner package can run inside an Upstash Box, a VPS or a container and connect back over the same protocol. That's the seam for the software factory; no remote backend ships in v1.

### 4.3 Runner protocol

A versioned, zod-typed message protocol over one WebSocket:

- **Server → runner commands:** `workspace.prepare`, `session.start`, `session.send`, `session.steer`, `session.interrupt`, `session.respond` (approval or answer), `session.stop`, `pty.*`, `browser.*`, `git.*`.
- **Runner → server events:** normalized agent events (§7.3), process status, terminal output, browser frames. Each event carries a monotonically increasing `seq`, which the server acknowledges. Provider lists (with each provider's models) are sent at the handshake and again whenever a list changes, for example once model discovery finishes.
- **Handshake:** the protocol version, runner version and capabilities are exchanged on connect.

### 4.4 MCP access path

Agents always call a **local MCP proxy inside the runner** (`http://127.0.0.1:<runnerPort>/mcp`). The proxy forwards to the server's `/mcp` over the runner connection, with the session's scoped token. Locally and remotely, agents see the same localhost address and nothing extra is exposed.

## 5. Repository layout

```
codeden/
  apps/
    server/     Hono server, DB, orchestration, MCP tools, scheduler, GitHub sync
    web/        React SPA
    runner/     runner process: adapters host, pty, browser, git, MCP proxy, journal
    desktop/    the desktop app (§17): Electron main, preload bridge, server host, packaging
    cli/        the published `codeden` package (CLI entry, bundles server + runner + web)
  packages/
    contracts/  zod schemas: event model, runner protocol, WS messages, settings
    providers/  provider adapters (claude, codex, later opencode, acp, fake, replay)
  docs/
```

The published `codeden` npm package bundles the server, runner and CLI with tsdown, and includes the prebuilt web assets. Permissively licensed pure-JS dependencies are inlined (their licenses ship in `dist/THIRD-PARTY-NOTICES.txt`), so `npx codeden` installs only the native modules and `playwright-core`. The **Claude Agent SDK is not redistributed**: on first use it is installed from npm into `~/.codeden/deps/` with `--omit=optional --omit=peer` (about 5 MB; its platform binaries are never needed because the adapter runs the user's installed `claude`, and its JS entry needs no peers). A lock file keeps the server and runner from installing it twice; in the workspace it resolves from `node_modules` instead.

## 6. Data and persistence

- **Data directory:** `~/.codeden/`, overridable with `CODEDEN_HOME`. Two copies (for example a development build next to your stable copy) can run side by side with different homes and ports.
  - `codeden.db`: the SQLite database.
  - `settings.json`: user settings, non-secret.
  - `runner/`: the runner lock file and event journal.
  - `wt/<project>/<session>/`: git worktrees. Short paths, to stay clear of Windows path-length limits.
  - `artifacts/`: screenshots and files shared in chat.
  - `logs/`
- **Secrets** (an optional ElevenLabs key, API keys if a user chooses that mode) live in the **OS keychain** through `@napi-rs/keyring`, never in files. GitHub and provider credentials are inherited at runtime, not stored (§14).
- **Event log.** Append-only `events` table (`seq`, `session_id`, `type`, `payload`, `ts`). **It's never pruned**: it's the audit trail and the replay source.
- **Projections.** `projects`, `sessions`, `threads`, `turns`, `items`, `inbox_items`, `automations`, `automation_runs`, `github_issues`, `github_prs`, `artifacts`. They're written in the same transaction as the event that produces them, so they can be rebuilt from the log.
- **Migrations.** Drizzle migrations from the first commit.
- **Realtime to the UI.** The client loads a snapshot that includes the current `seq`, then subscribes to events after it over the WebSocket. On reconnect it resumes from the last `seq` it saw. Large tool outputs are fetched on demand rather than pushed.

## 7. Agents and providers

### 7.1 Adapter interface

Each provider is an adapter in `packages/providers`, loaded by the runner:

```ts
interface ProviderAdapter {
  id: "claude" | "codex" | string;
  detect(): Promise<ProviderStatus>;          // installed? version? logged in? (§14)
  capabilities(): ProviderCapabilities;
  openSession(opts: SessionOptions): Promise<ProviderSession>;
}

interface ProviderSession {
  events: AsyncIterable<AgentEvent>;          // normalized (§7.3)
  send(input: UserInput): Promise<void>;      // starts a turn
  steer?(input: UserInput): Promise<void>;    // inject into a running turn
  interrupt(): Promise<void>;
  respond(requestId: string, response: RuntimeResponse): Promise<void>; // approvals, questions
  close(): Promise<void>;
  resumeToken(): string | undefined;          // provider session/thread id for resume
}
```

**`ProviderCapabilities` flags:** `resume`, `steer`, `interrupt`, `approvals`, `userQuestions`, `subagents`, `rollback`, `fork`, `images`, `planMode`, `reasoningEffort`, `mcp`, `skills`.

### 7.2 Providers

- **Claude Code.** Uses the Claude Agent SDK `query()` with streaming input:
  - **Binary:** `pathToClaudeCodeExecutable` points at the user's installed `claude`, which inherits their login and settings.
  - **Approvals:** `canUseTool` maps to approvals, and `resume` handles sessions.
  - **Subagents:** messages tagged with `parent_tool_use_id` become child threads.
  - **CodeDen tools:** CodeDen's MCP proxy is passed in through `mcpServers`.
  - **Versions:** the SDK version is pinned to one we've tested against.
- **Codex.** Starts `codex app-server` and speaks JSON-RPC:
  - **Methods:** threads, turns, items, approvals and steering.
  - **Types:** protocol types are generated from the installed Codex version.
  - **Permissions:** sandbox and approval policies map onto CodeDen's autonomy levels (§11.2).
  - **CodeDen tools:** the MCP server is injected through config overrides.
- **Fake and Replay** (development and tests only):
  - **Fake** is a scripted provider for demos and deterministic tests.
  - **Replay** plays back sessions recorded from the real CLIs, so the test suite never pays for agent turns.
- **After v1:** OpenCode through its official SDK, and a generic ACP adapter that opens up the long tail of ACP-speaking agents.

### 7.3 Normalized event model

A conversation is a **thread** made of **turns**, and each turn holds **items**. Agent events:

- **Session and turn lifecycle:** `session.updated`, `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted`.
- **Items:** `item.started`, `item.delta`, `item.completed`. Item kinds:
  - `user_message`, `assistant_message`, `reasoning`
  - `tool_call`, with a `toolKind` of `command`, `file_edit`, `file_read`, `search`, `web`, `mcp`, `browser` or `other`
  - `plan` / `todo_list`
  - `approval_request`, `user_question`
  - `subagent` (links to a child thread)
  - `notice`, `error`
- **Usage:** `usage.updated` (tokens, cost where reported, rate-limit state).

**Failed turns are classified** by the adapter in `ErrorInfo.kind`: `transient` (overloaded or failing API, dropped connection, the CLI exiting), `usage_limit` (with `retryAt` when the provider says when the limit resets), `context_full`, `auth` or `fatal`. Adapters read their own signals (Claude: the turn's assistant error, `api_error_status`, `terminal_reason` and the last rejected rate-limit window; Codex: `codexErrorInfo` and the latest rate-limit snapshot); nothing outside them looks at a provider id.

**Automatic retry** (`settings.sessions.autoRetry`, default on). When an agent session's root turn fails as `transient` or `usage_limit`, the session goes idle with no inbox item, and the server continues it with a `codeden` message ("Previous turn stopped (<reason>); continue where you left off."): after 20 s, 90 s and 5 min for transient failures (at most three in a row), or a minute after a usage limit resets. A notice in the failed turn says when. A user message or Stop cancels a pending retry; pending retries are derived from the turns table, so a restart keeps them. When the retries run out, there is no reset time, or the setting is off, the session fails as before (`failed`, a `run_failed` inbox item and the PM notices that follow). Orchestrator and PM sessions are never retried this way.

**Subagents** are child threads with `parentThreadId` and `parentItemId`. The parent transcript shows a compact subagent card with live status. Clicking it opens the child thread in a side panel or as its own view, and approvals raised inside a subagent surface in the parent and in the inbox.

### 7.4 Utility model

Small side jobs use one configurable **utility model**, so they never need a separate API key:

- **The jobs:** follow-up prompt suggestions (§13), compressing a final message for read-aloud (§11.3), session titles, and short summaries in notices.
- **How it runs:** a one-shot call through an installed provider with no tools. The default is a small Claude model through the Agent SDK, or a small Codex model when only Codex is set up.
- **Controls:** the model is chosen in Settings, and each job can be switched off. The read-aloud TL;DR is controlled by `voice.readAloud.content` (§11.3), not by a job toggle.
- **Failures are visible:** a failed or empty one-shot, and having no provider that can run one, are written to the server log (stderr) whatever the debug setting, and the job falls back as described for it.

### 7.5 Follow-up prompts

When a turn completes, CodeDen offers two to four suggested next prompts:

- **Primary source:** the agent calls `suggest_followups` as its last action. CodeDen's system prompt asks it to, and the agent has the full context at no extra cost.
- **Fallback:** when the agent didn't call the tool, the utility model proposes follow-ups from the final message and the turn's changes.
- **In the UI:** suggestions are stored as an item on the turn and shown as chips above the composer. A click fills the composer for editing; a setting makes it send straight away.
- **PMs** can read an agent's follow-ups when deciding what to do next.

## 8. Orchestration

### 8.1 Roles

All three roles are the same kind of agent session, differing only in **role**, **system prompt**, **working directory** and **tool set**. Each can run on any provider. Claude Code is the default for the orchestrator and PMs, and each role can be switched to another provider.

| Role | Count | Works in | Purpose |
|---|---|---|---|
| Orchestrator | 1 | `~/.codeden/orchestrator/` | Your front door. Creates and configures projects, routes requests to PMs, summarises status across projects |
| Project Manager | 1 per project | Read-only view of the repo | Triages issues, plans work, starts and steers agent sessions, reviews results, escalates to you |
| Agent | many | Its own worktree and branch | Does the work: code, tests, PRs, evidence |

### 8.2 How work flows

1. **Work arrives.** You ask the orchestrator, a PM picks up a GitHub issue, or an automation fires.
2. **The PM starts an agent session.** It names a provider, model, issue link and brief; CodeDen creates the worktree and branch, then starts the session on the runner.
3. **The agent works.** It may ask questions (inbox), request approvals (inbox), share screenshots, and finally opens a PR with evidence linked to the issue.
4. **Notices wake the PM.** Session events become **typed notices** (`session.finished`, `session.needs_input`, `pr.opened`, `pr.checks_failed`, …). They're batched and debounced, and wake the PM with an "updates since your last turn" summary. A loop guard limits wake-ups: it paces agent-to-agent ping-pong (orchestrator ↔ PM, PM ↔ its sessions) per conversation while no person steps in. Anything the user started goes straight through and clears the counts, and a paced message is queued and delivered automatically, never refused.
5. **The PM decides.** It follows up with the agent and makes routine calls itself with sensible defaults, stating what it assumed. It merges nothing on its own unless that project's policy allows it, and escalates to the orchestrator or the inbox only for decisions that are the user's: destructive or irreversible actions, spending money or credentials, outward-facing actions (releases, publishing, deploys, messages to people), protected areas, and conflicting priorities.
6. **The orchestrator wakes only for what matters.** PM messages can be marked informational so routine updates don't wake it.

Notices are structured data all the way to the UI, which renders them as cards; they're never encoded as text to be parsed back.

### 8.3 Internal MCP tools

One tool registry, exposed through MCP and also called directly by the UI's API handlers, so the agents and the UI can never drift apart. Each tool is one module:

```ts
defineTool({
  name: "start_session",
  description: "...",
  roles: ["pm"],
  input: z.object({ /* ... */ }),
  scope: "project",                 // resolved from the caller's token
  handler: async (input, ctx) => { /* calls the same service the UI uses */ },
});
```

- **Scoping.** Each session gets an MCP bearer token encoding its role, project and session. The token is revoked when the session ends. Tools outside the caller's role aren't listed at all.
- **Tool loading.** A small set of core tools is always loaded; the rest are deferred behind tool search so large tool sets don't fill the context window.
- **Situational-awareness tools** (§8.4) are core tools for the orchestrator and PMs and are always loaded.
- **Initial tool set** (to be extended):
  - **Orchestrator:** `list_projects`, `create_project`, `update_project`, `message_pm`, `ask_pm`, `get_overview`, `list_inbox`.
  - **Orchestrator and PM:** `schedule_wakeup`, `list_wakeups`, `cancel_wakeup` (a wake-up they schedule for themselves, stored as a `reminder` notice held back until it is due, so they follow up later without the user).
  - **PM:**
    - Sessions: `list_sessions`, `start_session`, `message_session`, `stop_session`, `answer_question` (questions from work it, the orchestrator or an automation started; approvals stay with the user).
    - Issues: `list_issues`, `get_issue`, `triage_issue` (labels, comment, accept/decline), `create_issue`.
    - PRs and escalation: `get_pr_status`, `ask_user`, `message_orchestrator`.
    - Automations and notes: `list_automations`, `run_automation`, `read_project_notes`, `update_project_notes`.
    - Factory projects (§10.1): `factory_status`, `factory_admit_issue` (only at the user's request), `factory_set_type`, `factory_allow_large_change`.
  - **Agent:**
    - People: `ask_user`, `message_pm`, `report_progress`.
    - Sharing and evidence: `share_to_chat` (file or screenshot), `attach_evidence` (to an issue or PR).
    - Results: `create_pull_request`, `suggest_followups`, `finish` (with a structured result).
    - Factory sessions (§10.1), listed only to the session in that role: builders `factory_report_reproduction`, `factory_submit_analysis`; reviewers `factory_submit_review`; the scout `factory_plan_round`, `factory_file_issue`; its area reviewers `factory_report_findings`.
    - Browser tools (§12.2).
  - **All roles:** `generate_image` (§12.5).

### 8.4 Situational awareness and conflict handling

The orchestrator must always know what's happening across all projects, and each PM must know everything running in its project, including scheduled work that hasn't started yet. Starting work must never silently duplicate work already running.

- **Every unit of work is described in data.** Each session and automation run records:
  - `startedBy` (user, orchestrator, pm or automation, with the id)
  - `purpose` (one line)
  - `workKey`, a stable identifier of *what* the work is: for example `automation:security-audit`, `issue:142` or `pr:57`, or one derived from the request
  - `scope` (project, paths or area)
  - status, progress (the last `report_progress` call) and timestamps
- **Status digest injected on every wake.** Each time the orchestrator or a PM wakes, CodeDen adds a compact, up-to-date digest to its context, so it knows the current state without spending a tool call:
  - **PM digest:** running and queued sessions (`workKey`, purpose, status, progress, age); the next scheduled runs of the project's automations; open inbox items; recent finishes and failures.
  - **Orchestrator digest:** the same, rolled up per project.
- **Awareness tools** (always loaded):
  - **Orchestrator:** `get_overview` (every project: running work, upcoming scheduled runs, inbox counts, recent outcomes).
  - **PM:** `get_project_status`, `list_sessions` (filter by status, `workKey`, startedBy), `get_session` (one session's last message, what it waits on, its result), `list_scheduled_runs` (upcoming runs per automation), `skip_next_run`, `pause_automation`, `resume_automation`, `cancel_queued_run`, `stop_session`.
- **Conflict detection is built into starting work.** `start_session`, `run_automation` and scheduled triggers first check for running or queued work with the same `workKey`, or an overlapping `scope` for the same kind of work, in that project.
  - **When there's a match,** the call returns `conflict` with the existing work's details instead of starting anything.
  - **The caller then picks one of:** `wait` (queue behind it), `skip`, `join` (send the request to the existing session as a follow-up), or `force` (start anyway, with a reason that's recorded).
  - **Example:** you ask the orchestrator for a security audit. It asks that project's PM, which sees `automation:security-audit` already running, picks the resolution itself (here `skip`, since it is the same work) and replies with the audit's progress and what it chose. Nothing is duplicated. Only conflicts from work you start yourself come to you as a card.
- **Scheduled triggers when the previous run is still going.** The default guard is `skip-if-running`. Each automation can instead choose `queue` or `run-anyway`.
  - **Skipped runs** are recorded as `automation_run` rows with status `skipped` and the reason, and a notice wakes the PM, which may choose to take over or adjust the schedule.
  - **The PM can act ahead of time,** for example skipping the next cron run because an audit started by hand will still be going.
- **Cross-project view.** The orchestrator's overview flags work running in several projects at once, including conflicts it can't resolve itself; those go to your inbox.
- **UI:** each project shows a **Now / Next** strip (running work and upcoming scheduled runs). A conflict surfaces as a card with the same `wait`, `skip`, `join` and `force` actions.

## 9. Git and GitHub

- **Worktrees.** Each agent session gets a worktree under `~/.codeden/wt/` on a new branch. Branch names follow the project's convention, with `codeden/<slug>` as the fallback. Sessions can also run in the repo root or an existing worktree when chosen explicitly. In a GitHub project the runner fetches `origin` first and branches from `origin/<default>` when the local default branch is behind it (or equal); a local default branch with commits of its own is kept, and an offline fetch falls back to it. The pull request still targets the default branch. CodeDen's git runs with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so a background fetch never opens a sign-in window.
- **Worktree cleanup.** Archiving a session removes its worktree; an hourly sweep retries archived sessions whose removal failed and removes worktrees of sessions inactive for a configurable number of days (default 7), unless the session's pull request is still open. Uncommitted changes always keep a worktree unless the user forces removal (the toast says when changes were discarded). The branch and checkpoints stay, and the next message to the session recreates the worktree at the same path from its branch, running setup again. Cleanup goes through the runner's `workspace.remove` / `workspace.prepare` commands, so a remote runner cleans up its own storage the same way.
  - **Deleting safely.** The runner deletes worktree folders itself, never through `git worktree remove`: on Windows Git treats junctions as folders, deleting the contents of whatever a pnpm `node_modules` junction points to and stopping at dangling ones. A folder under `~/.codeden/wt/` is renamed into `~/.codeden/wt/.trash` (all or nothing: if a process holds a file open the worktree stays intact and the removal reports it in use), `git worktree prune` drops the record, and the trash is emptied in the background and on runner start. Symlinks and junctions are unlinked, never followed. A folder under `~/.codeden/wt/<project>/<session>` that is no longer a git worktree (left half-deleted) is removed the same way, and `workspace.prepare` clears one at its target path. Anything outside that folder is deleted only if git lists it as a worktree of the project, and never if it contains the repository or another worktree.
  - **Leftover processes.** Before a removal, and when a session in its own `~/.codeden/wt/<project>/<session>` folder stops, the runner also ends processes it doesn't track that run from or in the folder: executable inside it, working directory inside it (POSIX), or a path inside it on the command line, matched as whole paths (never a sibling with the same prefix). Only processes CodeDen's agents or terminals started count: the runner's descendants, and what descends from a process orphaned after the runner started (an agent's shell left behind by its CLI). The runner, the server and their ancestors are never ended, nor the user's own editors and shells, nor (on stop) the user's CodeDen terminals or a folder another hosted session works in.
  - **Visible failures.** A removal that still fails raises one `cleanup_failed` inbox item per session (updated when the reason changes, left alone once dismissed), which CodeDen resolves when a later attempt removes the worktree. The desktop server always writes its log lines to `<home>/logs/desktop-server.log`.
- **Setup scripts.** `.codeden/project.json` can define commands such as `pnpm install`, which run when a worktree is created, plus a dev-server command and the default provider. Setup stops at the first failing command and the session starts anyway; the agent's first input is prefixed with "Setup command `X` failed (exit N):" and the end of the command's output, so it knows why the worktree may be incomplete.
- **Turn checkpoints.** At the end of each turn the runner snapshots the worktree into a hidden ref (`refs/codeden/checkpoints/<session>/<n>`). It uses a temporary index (`write-tree` → `commit-tree` → `update-ref`), so the user's branch and index are never touched. This gives exact per-turn diffs and file-level undo; full rollback is offered only when the provider can also roll back its conversation.
- **GitHub API.** Octokit on the server, authenticated with the token from `gh auth token` (read at runtime, not stored). Agents use `gh` inside their worktrees.
- **Sync.** Issues, PRs, checks and reviews are polled with conditional requests (ETags) and batched GraphQL. A local app can't receive webhooks; webhook support arrives with remote runners.
- **Traceability.** Every session records its issue, branch, PR and commits. PR bodies link the issue (`Fixes #N`) and the CodeDen session.
- **PR feedback for user sessions.** Notices wake the PM only for work it, the orchestrator or an automation started. For an open agent session the user started, the server instead sends the session a `codeden` message when its pull request's checks fail (failing check names and links), a review requests changes, or it becomes `conflicting`: once per head commit and at most three per PR, recorded with the session's start metadata so a restart doesn't repeat them. `settings.sessions.prFeedback` (default on) switches it off.
- **Evidence.** Screenshots and test artifacts are committed to a dedicated orphan branch (`codeden/evidence`) and linked from PR and issue comments, so GitHub renders them inline. Test output and summaries are posted as comments.
- **Local-only projects** (no GitHub remote) get sessions, worktrees, checkpoints, diffs and automations, but no issue, PR or evidence flow.
- **Re-detection.** A project's git checkout and GitHub `origin` are checked again on server start, after agent turns in local-only projects, and on demand. A folder that gains a GitHub remote becomes a GitHub project; one that loses it is never downgraded on its own: it gets a warning, and the user restores the remote or disconnects GitHub.

## 10. Automations

- **What an automation is:** a **trigger**, an **action**, a **target** and **guards**.
  - **Triggers:** `cron` (croner, in the project's timezone), `event` (`session.finished`, `pr.opened`, `pr.merged`, `pr.checks_failed`, `issue.opened`, `issue.labeled`, …), or `manual`.
  - **Actions:** start an agent session with a prompt template, message the PM, or run triage. A session action carries its agent (provider, model, effort) and its **permissions** (the §11.2 level, Read-only to Full), separate from the automation itself.
  - **Guards:** an overlap policy (`skip-if-running`, the default, or `queue` or `run-anyway`, using the `workKey` conflict check from §8.4), a concurrency cap, quiet hours, a maximum per day, and catching up missed runs after downtime.
- **Templates** are Markdown files with YAML frontmatter (trigger, provider, autonomy, prompt), so they're readable and editable. Built-in templates:
  - security audit
  - refactor sweep
  - dependency updates
  - UI review
  - test coverage gaps
  - issue triage
  - stale PR follow-up
- **Where they live.** Global templates live in `~/.codeden/automations/`. Project automations live in the repo's `.codeden/automations/` (commit them or not) or in the database.
- **Creating and editing in the UI.** **New automation** opens one editor: name and target, when it runs (human schedule choices that compile to cron, with a plain-English summary and the next three runs in a chosen timezone; an event in plain words; or only when run by hand), the prompt with an "Insert placeholder" menu, the unified provider/model/effort picker, the permissions ladder, and advanced options (session title, work key, guards) collapsed. Templates open the same editor prefilled. Database automations stay editable on their page, with duplicate and delete; file-based ones are read-only there, with "Duplicate to edit". PMs create and change database automations with `create_automation` and `update_automation`, under the same validation (`createdBy: pm`).
- **Sharing.** The Markdown + frontmatter format is also the exchange format: export one automation (`<slug>.md`, or copied as Markdown) or a project's automations as a `.zip`; import `.md` files, a zip or pasted text. Imports go through the file parser and validation, refuse unknown fields, are size- and count-limited before parsing, never run anything, and create database automations (`createdBy: import`) that start off; Full permissions are flagged in the preview.
- **Control.** Everything is toggleable globally, per project and per automation. **All automations are off by default**: a new project offers a starter set to enable; new, imported and PM-created automations start off too.
- **Issue triage.** The PM reads new issues and classifies them as ready, needs info, unsafe, out of scope or duplicate. It applies labels and comments according to project policy, and either starts a session or puts a decision in your inbox when unsure ("Should I take this on?").
- **Visibility.** Every automation run is a normal session (or PM turn) with a full transcript, so background work stays visible.

### 10.1 Project autonomy modes, the software factory and the dark factory

(Redesigned 2026-11-11: "Autopilot" became the **software factory**, work runs through typed pipelines, merging is manual unless auto-merge is on, and only trusted authors' issues are taken on.)

Each project has an **autonomy mode**, a ladder you can climb one step at a time:

| Mode | Who finds work | Who merges | You |
|---|---|---|---|
| **Manual** | You | You | Drive every session |
| **Assisted** | You, the PM (triage) and automations | You | Review PRs and answer the inbox |
| **Software factory** | You and trusted authors, as GitHub issues | You; CodeDen with **auto-merge** on | File issues and review PRs |
| **Dark factory** | The above, plus a scheduled **scout** | As above | Set the vision and the limits, then step away |

The mode id is `software_factory`; `autopilot`, its id before 0.6, is still read as `software_factory`.

**The software factory.** Issues are created outside CodeDen (by you, teammates, or any tool that files GitHub issues). A GitHub repository is required; GitHub is the only forge in v1. Server code, not an agent, runs the loop:

```
                       ┌─ Bug:      Reproduce ─► Create fix ─► Review fix ─┐
Issue ─► Identify type ┼─ Feature:  Analyze ───► Implement ──► Review ─────┼─► Merge
                       └─ Docs:     Implement docs change ─────────────────┘
                                         ▲    (Revise)    │
                                         └────────────────┘
```

1. **Intake.** New issues (opened after the mode was switched on, or labelled `codeden-factory`) become work items.
2. **Trust.** Only issues by **trusted authors** are taken on: the logins in the project's `trustedAuthors` and the account CodeDen uses on GitHub. On a public repository anyone can open an issue, and an issue is a prompt for an agent, so everyone else's issues are **ignored**: listed, with no model call, session or comment. A person can **let one in** (the UI, or the PM when the user asks it to); such work runs through its pipeline but is **never merged automatically**. Labels never grant trust. The factory never acts on pull requests other people open.
3. **Identify type.** One call to the utility model (§7.4) classifies each trusted issue as a **bug**, a **feature** or a **docs** change; a GitHub label settles it first, keywords decide when no model answers. The issue is labelled and told its pipeline.
4. **Assign.** The server is the orchestrator of an agent swarm: queued items go to free agents within **Agents at once** (`maxConcurrentSessions`), by priority, then age. Each item gets one builder session in its own worktree.
5. **Pipelines.** Bug: **Reproduce** (a failing test or probe, reported with `factory_report_reproduction`; not reproduced stops with a comment) → **Create fix** → **Review fix**. Feature: **Analyze** (does it exist already, does it fit the vision and architecture; a spec and acceptance criteria with `factory_submit_analysis`, posted on the issue) → **Implement** → **Review**. Docs: **Implement docs change**, with no agent review while the change touches only documentation. The builder's report answers with its next step, so one session carries the item.
6. **Review and revise.** A **review by a separate agent session**, on a different provider from the author when one is available. `request_changes` or any failed merge check sends the work back to the builder: the revise loop, up to `maxFixAttempts` rounds.
7. **Evidence.** Every pull request carries its **test results** (a `## Test results` section, or test output attached with `attach_evidence`) and, for UI changes, **screenshots**. Both are merge checks.
8. **Merge.** With every check green the PR is **ready for you** (an inbox item and a PR comment) and you merge it on GitHub. With **auto-merge** on, CodeDen squash-merges trusted work itself, then watches CI on main; a regression opens an **automatic revert PR**, pauses the loop and raises an inbox item.

**Merge checks** (all must pass): CI green; tests the change needs exist; test results reported; the independent review (skipped for docs-only changes); security and dependency scans clean; screenshots for UI changes; under the size limit (reviewable code only; work that cannot be split is allowed by the PM as a recorded decision); no protected area touched (protected changes always come to you).

**The dark factory** adds a **scout**: one long-lived agent session per project that, when fewer than `minBacklog` items wait and `discoveryIntervalMin` has passed, reviews the app against the vision and files the work worth doing as GitHub issues. It may use **review areas** (UI and UX, performance, security, features, bugs, code quality, test gaps, docs), each with an **area reviewer**: a long-lived reviewer session for that one area, reused round after round so it keeps its context. To keep token use down the server enforces: at most `discoveryPerRound` review areas per round (**Review areas per round** in the UI) and only on free agent slots (builders come first), at most one session per area ever, at most `maxIssuesPerRound` issues per round, and no round while the queue is full. Filed issues enter the pipelines already typed.

**Vision.** Both factory modes require a project vision in `.codeden/VISION.md`, edited in the UI. It covers goals, target users and principles; what is out of scope; the quality bar; and **protected areas** (paths or topics that always need a human: auth, payments, data migrations, infrastructure, licensing). Agents get it in their prompts; the analyzer checks requests against it; the scout finds work with it.

**Unattended in dark factory.** Nobody waits on the user in dark-factory mode. A question from the PM or a factory session (through `ask_user` or the provider's own question tool) is answered at once by the server: decide from the vision, which wins over the current code. The agent records each judgement call with `factory_record_decision`, and it reaches the inbox and the digest for review. Protected areas, a missing or self-contradicting vision, and irreversible actions outside the code are flagged at high priority, but the loop never blocks on them. Sessions the user starts still ask as usual. Approvals are never granted on the user's behalf: in a dark factory the PM's and factory sessions' approvals are **denied** at once with the same guidance, and sessions started by an automation, a PM or the factory in other modes wait 30 minutes for the user, then are denied (`decidedBy: policy`), so unattended work never waits forever.

**Limits** (required, enforced by the server, not left to agent judgement):
- agents at once, automatic merges per day (with auto-merge on)
- a token or cost budget per day
- **Pause on repeated failures:** the loop pauses after N failed merge checks or reverts in a row.
- **Protected areas** always escalate to you.
- **No deploys or releases** unless they're explicitly enabled as a separate automation.
- **A kill switch** on the project and globally: one click stops the loop and all its sessions, the scout and its area reviewers included.

**Visibility.** Factory work is ordinary sessions, issues and PRs, so it all stays traceable. The project page shows the **pipelines as a live diagram** (Issue, Identify type, the Bug, Feature and Docs lanes, Merge, and the scout in a dark factory) with each work item on the node of its current step; clicking an item opens the agent session working on it. Every lane, step, the scout, its rounds and review areas, and the less obvious limits explain themselves in plain words: a tooltip on the underlined term or a "?" beside it, opened by hover, keyboard focus or a tap. Around it: spend against budget, agents working, PRs ready for you, merge-check results, recent results, ignored issues with **Let in**, and a daily digest.

**Cleanup.** Finished work gives its space back. Once an item is merged, reverted, rejected or failed, the server archives its builder and reviewer sessions through the normal archive path (§9), which removes their worktrees and keeps the branch, checkpoints and transcript. Work that isn't finished keeps its sessions: escalated items, merges whose main CI is still watched, and an item that failed only on size while its PR is open (the PM may still allow it). A session is never cut off: the item waits while one of them is in a turn. An item's sessions are archived once (`sessionsArchivedAt`), so a session the user unarchives stays. **Retry** hands the earlier attempt's sessions to the same cleanup (`earlierSessionIds`, archived once none of them is busy), unless they were archived already. The scout and its area reviewers are never archived this way.

**Delivery.** Both factory modes ship marked **experimental**. Assisted remains the default for new projects.

## 11. Human in the loop

### 11.1 Inbox

The inbox is one view, also available as an MCP tool. It collects:

- questions from agents
- approval requests
- PRs ready for review
- failed or stuck runs
- triage decisions
- automation results flagged for attention

Each item links to its session, issue and PR, and can be answered in place. The sidebar shows a count, and items also raise toasts and opt-in browser notifications.

Approvals and questions block an agent, so they get stronger cues. When one arrives live, a short chime plays (synthesized in the browser, debounced so a burst plays once, on by default and switchable in Settings) and a sticky toast with **Open** stays until the item is opened or resolved. While any is open, the favicon carries an amber dot, and a background tab's title alternates with "Waiting on you". The first such toast also offers, once, to turn on browser notifications.

### 11.2 Autonomy levels (Permissions)

The UI calls these **Permissions** and shows them as a ladder, **Read-only → Supervised → Auto → Full**, with one plain line each; they are stored as `autonomy` (`read_only`, `supervised`, `auto`, `full`) on sessions, projects, settings and automation actions. Each level maps onto each provider's **native** enforcement:

- **Read-only:** can read and run checks, but never edits files, commits or pushes.
  - Offered only where the provider reports `capabilities.readOnly`; the server refuses `read_only` agent sessions on other providers. UI and orchestration read the capability, never the provider id.
  - **Claude:** the `default` permission mode, with CodeDen's PreToolUse hook denying the edit tools and every shell command outside the read-only allowlist. Agent sessions may also run the project's checks (test, lint, type-check commands without fix, write, snapshot-update or watch flags). The hook decides per call, so the level can change live.
  - **Codex:** the read-only sandbox with `never` approvals and no network: writes fail instead of asking; it applies from the next turn.
  - CodeDen's `create_pull_request` is hidden from and refused for read-only sessions.
  - The orchestrator and PMs are read-only by role (`SessionOptions.readOnly`) at every level, without checks.
- **Supervised:** every edit and command asks.
- **Auto, risky actions ask** (default):
  - Edits and normal commands inside the worktree run freely.
  - Risky actions go to the inbox: writes outside the worktree, force pushes, deleting branches, global installs, network access to unlisted hosts, and secrets access (reading a credentials file or dumping the environment; search patterns, file names used as data and creating an env file inside the worktree are not access).
  - **Claude:** `acceptEdits` plus a `canUseTool` policy classifier.
  - **Codex:** workspace-write sandbox (network off) plus on-request approvals. The sandbox keeps `.git` read-only and blocks the network, so Codex asks to escalate for ordinary work (`git commit`, `pnpm install`). CodeDen runs every such request through the same risk classifier: what the level allows is approved by policy at once (recorded as `decidedBy: policy`, never shown as a card to answer), and only risky actions reach the user. Patches and extra permissions are judged by their paths the same way. An approved escalation runs outside Codex's sandbox, as Claude's commands do.
- **Full:** no approvals inside the worktree.
  - **Claude:** `bypassPermissions`, and the classifier asks only for writes outside the worktree.
  - **Codex:** workspace-write sandbox with the network on, plus on-request approvals that CodeDen's policy approves unless they write outside the worktree. (With `never`, Codex could not commit at all, since the sandbox keeps `.git` read-only.)
- **The OS temp directory** (`os.tmpdir()`, `%TEMP%`/`%TMP%`, `$TMPDIR`, `/tmp`, and Git Bash's `/tmp` on Windows) counts as inside the worktree for writes and deletes under Auto and Full, so logs and scratch files there don't ask. Only the temp directories themselves qualify: never their root, a filesystem root or the home directory, and a secrets file written there still asks. Supervised is unchanged.
- **The session's own branch** (the branch of its own worktree, `SessionOptions.ownBranch`; never its base branch or `main`/`master`) may be force-pushed **with a lease** without asking, as after a rebase; plain `--force`, refspecs with `+` and remote deletions still ask. `git branch -d` (merged work only) doesn't ask; `-D` does. `create_pull_request` retries a rejected push of the session's own branch with a lease.
- **Claude's own notes** (its plans folder, `plansDirectory` or `~/.claude/plans`, and the project's auto-memory folder) count like the temp directory for Claude sessions under Auto and Full: plan mode and memory writes don't ask. Only the user's own Claude settings can move them, never a folder covering Claude's config folder, the home directory or a filesystem root, and a secrets file there still asks.
- **The classifier reads commands like a shell:** quoted text, heredoc bodies and PowerShell here-strings are data, redirects count only outside quotes, and relative paths resolve from where a `cd` (in the same command, or an earlier one Claude reports) moved the shell.
- **Changing the level on a running session** saves it on the session (`PATCH /api/sessions/:id`, recorded as `session.updated`) and sends it to the live provider session. Claude applies it from the next tool call (`liveAutonomy`); Codex from the next turn, through per-turn approval and sandbox overrides. Approvals already waiting stay waiting.

The orchestrator and PMs have no write access to project code; they act only through CodeDen tools.

### 11.3 Voice

Both sides sit behind provider interfaces, so engines can be swapped:

- **Speech to text** (composer dictation, push-to-talk with a keyboard shortcut):
  - **Default:** the browser speech API.
  - **Optional:** a cloud engine (ElevenLabs or OpenAI).
  - **Optional:** **local Whisper**, offline and private, for browsers and shells without a working speech service (Firefox, Electron). Details below.
  - **Feature detection.** The browser engine counts as available only when the recognition API exists and its speech service has not failed here (a `network` or `service-not-allowed` error is remembered per browser until the user picks the browser engine again). Where it is unavailable, Settings and setup say so and suggest Local (Whisper). This is capability detection, never a check for a particular browser or shell.

**Local Whisper.** `voice.dictation.engine: "local"` with `voice.dictation.local.model`.

- **Where it runs.** On the CodeDen server, like the cloud engines: the UI records with `MediaRecorder`, decodes and resamples the clip in the browser (Web Audio) to **WAV, 16-bit PCM, mono, 16 kHz**, and uploads it to `POST /api/stt?engine=local`. The server validates the WAV (format, at most 120 s) and transcribes it in-process, so no audio decoder (ffmpeg) is needed on the server, and the same path works in a plain browser, in the desktop app and later from a phone on the LAN. One clip is transcribed at a time; the loaded model is freed after ten idle minutes.
- **Runtime: whisper.cpp as a Node-API addon.** The prebuilt `index.node` for the platform is fetched from the npm registry as the tarball of `@fugood/node-whisper-<platform>-<arch>` (MIT) and extracted by CodeDen itself, so **no npm, compiler or system Node.js** is involved. Node-API keeps it loadable from any Node or Electron version. Prebuilt for all six targets (Windows, macOS, Linux; x64 and arm64), about 1.2 to 1.6 MB to download (2.5 to 4.8 MB on disk). Apple silicon uses Metal; elsewhere it runs on the CPU. Linux needs glibc 2.34+ and `libgomp1`; anything else reports "not supported" honestly.
- **Alternatives weighed.**
  - *whisper.cpp release binaries:* official builds cover Windows and Ubuntu but not a macOS command line (only an Xcode framework), and a CLI means temp files and process spawning per clip.
  - *whisper.cpp compiled to WASM:* one portable file, but several times slower than native on the CPU, the part that decides whether 30 s of dictation feels instant.
  - *transformers.js with ONNX Runtime:* `onnxruntime-node` ships every platform in one 300 MB package and needs npm to install sensibly; the WASM backend is slower again, and the JS library plus its dependencies would have to be assembled at runtime.
- **Models.** whisper.cpp GGML models from Hugging Face (`ggerganov/whisper.cpp`, MIT) at a pinned revision, 5-bit quantised (`q5_1`, about 40% the size of the full models with nearly the same accuracy): tiny / tiny.en (31 MB, fastest), **base / base.en (57 MB, default `base.en`)**, small / small.en (181 MB, most accurate). `.en` models are English-only and ignore the language setting; the others detect the language or take `voice.dictation.language`.
- **Downloads.** On demand, into `<home>/deps/whisper/<version>-<platform>/` and `<home>/models/whisper/`. Every file is pinned by size and **SHA-256** (a mismatch deletes it), written to a `.partial` file and resumed with an HTTP range request after an interruption (or restarted if the server ignores the range). `GET /api/voice/local` reports progress; `POST /api/voice/local/models/:id/download` starts or joins a download and `DELETE /api/voice/local/models/:id` cancels or deletes it. Nothing is in the published npm package, and nothing is fetched unless the user asks.
- **Speed.** Measured on Windows (AMD Ryzen 9 9950X3D) for a 4.7 s clip: `tiny.en` about 0.9 s, `base.en` about 2.0 s (2.1 s including the model load). Both transcribed it correctly apart from one word ("pool" for "pull" in synthesized speech). Measure on your machine with the opt-in test: `CODEDEN_REAL_WHISPER=1 pnpm --filter @codeden/server exec vitest run test/live/whisper.live.test.ts` (set `CODEDEN_REAL_WHISPER_MODEL=base.en` for the default model).
- **Text to speech** (reads an agent's final message when its turn completes):
  - **Default:** the browser's `speechSynthesis` (free).
  - **Optional:** ElevenLabs.
  - **What gets read** (`voice.readAloud.content`, Settings → Voice → What to read). Code blocks and markdown are always stripped.
    - **`summary` (default, "TL;DR"):** messages up to 220 characters are read as they are. Longer ones go to the utility model (§7.4) for a spoken TL;DR of at most two short sentences saying what was done and whether anything needs the user; the answer is hard-capped at two sentences and 220 characters (about 15 seconds). If no summary comes back (no provider, failure, 30 s timeout), the first sentence or two of the message is read, within the same cap. Summary mode never reads a whole report.
    - **`full` ("Full message"):** the whole stripped message, no model call, capped at 5,000 characters (about five minutes).
  - **One queue, no interruptions.** Finished turns from every session go on one first-in, first-out queue: a message plays to the end before the next starts. An item is skipped when its turn comes if it is no longer allowed (session muted, quiet hours, read-aloud off, "only when unfocused"); a turn is never queued twice; when more than three are waiting, the oldest waiting one is dropped, since the newest finishes matter most. The summary is prepared as soon as the turn finishes, so it is ready when its turn comes. The Settings **Test** button plays straight away, ahead of the queue. Switching read-aloud off stops what is playing and clears the queue; muting the session that is speaking stops its message.
  - **Who is speaking.** With `voice.readAloud.announceSpeaker` (default on, "Say who's speaking"), each message in either mode starts with who it is from: "Orchestrator: …", "<project> project manager: …", or "<project>, <session title>: …" for an agent session (titles cut at a word to 40 characters). The prefix is built in the UI from the session's role, project and title, never by the utility model, so it is instant and always right; the model only writes the TL;DR.
    - The older `utilityModel.jobs.readAloudSummary` toggle is superseded by this setting; it still parses so older settings files load, but nothing reads it.
  - **Controls:** global and per-session toggles, quiet hours, and "only when the tab isn't focused".

## 12. Workbench

### 12.1 Terminal

node-pty sessions owned by the runner, so they survive server restarts, with bounded scrollback history. The UI uses xterm.js. Each session has a terminal in its worktree, and you can open more.

### 12.2 Browser

- **Engine.** The runner launches Chromium through playwright-core: the installed Edge or Chrome first, with a download on first use only with consent. It is the engine in a plain browser tab, on phones and tablets, and the fallback everywhere. The desktop app adds a native engine (below).
- **Display, phase 1: full-panel screencast** (every surface). The page's viewport follows the panel's size and device pixel ratio, so the CDP screencast fills the panel edge to edge and stays sharp on HiDPI screens. Input coordinates map to the page correctly after every resize.
- **Display, phase 2: native views in the desktop app** (§17). Each tab is an Electron `WebContentsView` laid over the panel and kept in sync with its bounds. The screencast stays the display everywhere else.
- **Engine per session.** A session's browser opens on native views when the desktop app is connected, its **Native browser** setting (`desktop.nativeBrowser`, on by default) is on, and the desktop window or an agent opens it. Opened from a plain browser tab or a phone, or with no app, it opens on the runner's Chromium. An open browser keeps its engine until it closes or the app quits (hand-off, §17). Viewers learn the engine from the `/ws/browser` messages.
- **Human input.** There is no take-over step: clicks, typing and scrolling in the panel go straight to the page, in the screencast and in a native view alike. A small "Agent is acting" chip shows while an agent drives the page.
- **Agent tools.** Agents drive the **same browser** you see, on either engine:
  - navigate
  - accessibility snapshot
  - click and type
  - screenshot
  - console and network logs
- **Screenshots.** They can be posted to the chat with `share_to_chat` or attached as PR evidence.
- **Isolation.** One browser context per session in the runner's Chromium; one in-memory session partition per session for native views (`codeden-browser:<sessionId>`, never the window's own session). Cookies and storage never cross sessions.
- **Dev servers.** CodeDen discovers running dev servers so agents and you can open them in one click.
- **Spike first:** attach Microsoft's Playwright MCP over CDP rather than writing the tools ourselves. If several sessions can't share it cleanly, fall back to about ten tools of our own on playwright-core.
- **The key seam:** agents talk to the browser only through CDP. Native views are reached through a per-session CDP relay in the desktop app (§17), so the runner's agent primitives (aria snapshot, click by ref, screenshots, logs) work unchanged on either engine.

### 12.3 Files and diffs

A file tree for the worktree, a file viewer and editor (CodeMirror 6), turn and session diffs from checkpoints, and a PR view.

### 12.4 Agent configuration

First-class screens for each provider's own files:

- **Memory:**
  - Claude: global `~/.claude/CLAUDE.md`, project `CLAUDE.md` and `CLAUDE.local.md`, `.claude/rules/`, and the auto-memory folder.
  - Codex: `~/.codex/AGENTS.md` and repo `AGENTS.md` files, including nested ones.
- **Skills:** each provider's user and project skill folders, with create, edit and enable controls.
- **Subagents:** `.claude/agents/` and `~/.claude/agents/`, plus Codex equivalents where they exist.
- **MCP servers:** `.mcp.json`, Claude user config and `~/.codex/config.toml`. Add, edit, test the connection, and enable per provider.
- **What's loaded:** for any session, a view of which memory files, skills and MCP servers are in its context.

Edits are written to the native files in place (Principle 2), with a diff preview and a backup before overwriting.

### 12.5 Image generation

Any agent can generate images through the `generate_image` MCP tool, whatever its own provider can do. A Claude agent building a landing page can ask for a hero image, for example.

- **Tool input:**
  - `prompt`
  - `aspectRatio` or `size`, `count`
  - optional `referenceImages`, for edits and variations
  - `outputPath` inside the worktree
- **Tool output:** the file paths. Images are also saved as artifacts and shown inline in the chat.
- **Engines** sit behind an `ImageEngine` interface:
  - **Codex** uses the user's existing Codex login: CodeDen runs a short, tool-restricted Codex turn that generates the image and saves it to the requested path. It's the default when setup finds Codex logged in.
  - **Gemini** image models ("Nano Banana" and successors) take a Google AI API key.
  - **OpenAI Images** takes an OpenAI API key.
  - **More later** (fal, Replicate, local models) through the same interface.
- **Settings:**
  - the active engine, with a "test" button
  - default size and quality
  - per-project overrides
  - a daily cap
  - API keys are stored in the OS keychain
- **Unavailable engine.** If no engine is available, the tool is hidden from agents rather than failing at call time.

### 12.6 Usage and cost reports

Detailed, trustworthy reports on spend and usage across every provider, project and kind of work.

- **Ledger.** Every turn records a **usage delta**. It's computed from the provider's own figures: Claude reports cumulative session totals, so CodeDen stores the per-turn difference. Each delta holds:
  - input, output, cache-read and cache-write tokens
  - reasoning tokens where reported
  - cost in USD as reported by the provider
  - session, project, provider, model, role (orchestrator, PM or agent), `startedBy`, automation id and timestamp
- **Cost sources are labelled honestly.** Each figure is marked `reported` (the provider returned a USD cost) or `estimated` (tokens multiplied by a bundled, user-editable price table per model).
  - **API-key users** see actual spend.
  - **Subscription users** (a claude.ai or ChatGPT login) see an **"API-equivalent cost"**, clearly labelled as such, so they know what the same work would cost on API credits.
- **Rate limits.** CodeDen records each provider's limit status as it reports it: Claude's 5-hour and weekly windows, and Codex rate-limit snapshots from `app-server`. It shows how much of each window is used and when it resets, and can warn before a limit is reached.
- **Reports screen:**
  - a time range (today, 7 or 30 days, custom) and a total
  - stacked charts by day for provider, model, project and role
  - top sessions by cost
  - an automation and factory spend breakdown
  - cache hit rate
  - average cost per merged PR and per session
  - drill-down from any bar to the sessions behind it
  - CSV export
- **In context.** Cost and tokens appear on each session header and turn footer, a per-project spend card sits on project home, and the dark-factory budget meter (§10.1) reads from the same ledger.
- **Budgets and alerts.** Optional daily or monthly spend alerts globally and per project, delivered as inbox items and notifications. Factory limits enforce the same figures.

## 13. UI

- **Left sidebar.** The orchestrator chat is pinned at the top. Below it, the **Inbox** with a count, then projects. Each project expands to show its PM and its sessions, with status dots (running, waiting on you, done, failed) and linked issue and PR badges. Automations sit under each project. Projects can be pinned into a "Pinned" group above the rest and dragged to reorder within their group (or moved from the row menu); the order is stored on the server and every project list follows it.
- **Centre.** The chat transcript of the selected thread, virtualised for long histories:
  - streaming markdown (Streamdown) with Shiki code highlighting
  - tool calls grouped into collapsible work blocks with live command output
  - plans and todos as cards, subagent cards, approval and question cards answerable inline
  - typed notice cards
- **Composer:**
  - text, pasted images and file attachments, `@` file mentions, `/` commands and skills
  - provider, model and effort pickers, plus the autonomy level
  - queue or steer while a turn runs
  - the voice button
  - **follow-up chips** after a turn completes (§7.5)
- **Right panel** (tabs): diff, files, browser, terminal, issue/PR, session details. A bottom terminal drawer is optional.
- **Global:** command palette, keyboard shortcuts, settings, light and dark themes.
- **Phones and tablets.** The same layout adapts rather than a separate app (narrow desktop windows with a mouse keep the desktop layout): on phones (< 768 px) and portrait touch tablets (< 1024 px) the sidebar is a slide-out drawer opened from a menu button in every header; touch tablets in landscape (1024–1279 px) keep the icon rail, which expands into the drawer. In both, the right panel opens as an overlay sheet (full screen on phones) instead of squeezing the transcript, and phones use its Terminal tab instead of the bottom drawer. Touch screens get tap targets of at least 40 px and 16 px form fields, and hover-only affordances (row menus, copy buttons) are always shown when the device can't hover. A web app manifest and icons make **Add to Home Screen** open CodeDen full screen; there is no service worker (§15.1).
- **Platform bridge.** Notifications, opening links, folder picking, global shortcuts, clipboard images and badge counts go through one `PlatformBridge` interface in the UI. It has a web implementation and a desktop one (§17), chosen by detecting the desktop app's `window.codedenDesktop` bridge; features are read from `capabilities`, never "am I in Electron?". Browsers can't return real folder paths, so projects are added through a **server-side folder picker**, which also suits remote use; the desktop app (`capabilities.folderPicker`) uses the system folder picker, with the server-side one as a fallback.

## 14. First-run setup and inheriting credentials

The goal is to get from `npx codeden` to your first session in under a minute, without typing a single credential if your machine is already set up.

1. **Start.** `npx codeden` checks the Node version, creates `~/.codeden/`, generates the install token, starts the server and runner, and opens the browser on an already-authenticated URL.
2. **Detect.** One checklist screen with live ticks. All checks run in parallel and nothing is asked when a check passes:
   - **Finding the tools.** Claude Code, Codex and gh are looked for on PATH, then in their installers' own folders (Claude Code: `~/.local/bin`, and the older `~/.claude/local`; Codex: `~/.local/bin` and `$CODEX_HOME/packages/standalone`; gh: Program Files on Windows, Homebrew on macOS). Each copy found is checked before it is used: a shim's package must exist, a link must not dangle, and `--version` must answer within a few seconds (cached per file and modification time). Broken copies are skipped, so a working native install wins over a leftover npm shim earlier on PATH. When only broken copies exist the row says **installed but broken** and lists their paths; when nothing is found it says **not installed**. A re-check (and the runner's provider re-detect) first picks up PATH changes made since CodeDen started: on Windows from the user's and the machine's `Path` in the registry, added to the server's and the runner's PATH so agents and terminals started afterwards see them too.
   - **Claude Code:** `claude --version`, then `claude auth status`. This returns JSON with `loggedIn`, `authMethod` and `loginExpiresAt`. Logged in means ready; the Agent SDK uses the installed binary and its login.
   - **Claude Code support:** when `claude` is installed, a row for the Claude Agent SDK. It installs into `~/.codeden/deps/` when the user continues, with live progress; a failure shows npm's reason and a **Retry**. Sessions that start before it is installed install it themselves, and `codeden doctor --install` does it from a terminal.
   - **Codex:** `codex --version`, then `codex login status`. Logged in also enables **image generation through Codex** as the default engine (§12.5).
   - **GitHub:** `gh auth status`. Logged in means ready, and the token is read at runtime with `gh auth token`, never stored.
   - **git identity:** `git config user.name` and `user.email`.
   - **Browser:** an installed Edge or Chrome.
3. **Fix only what's missing.** Each failed check has one action:
   - The install command for the tool.
   - Or a **Sign in** button that runs the tool's own login (`claude auth login`, `codex login`, `gh auth login`) in an embedded terminal, so the provider's normal browser login flow handles it. It runs the exact copy detection found, by its full path and quoted for the terminal's shell (`& 'C:\Users\x\.local\bin\claude.exe' auth login` in PowerShell), so a broken shim or an outdated PATH in the terminal can't get in the way.
   - A login state that can't be read is a warning with the underlying error (exit code, output) in the row's details.
   - API keys are only an advanced alternative, never the default ask.

   At least one agent provider is required; GitHub is recommended but optional (local-only projects work without it).
4. **Optional extras,** skippable: voice (test the mic, choose read-aloud on or off, optional ElevenLabs key into the keychain) and notifications permission. A **"Use local Whisper for dictation"** card (§11.3) picks the local engine, starts downloading the runtime and the default model with live progress and offers the same five-second test as Settings. It is recommended when the browser has no working speech recognition, never blocks finishing setup, and the download carries on in the background when the user moves on.
5. **First project.** Pick a local folder or clone a GitHub repo. CodeDen detects the package manager and suggests a worktree setup script.
6. **Re-check on every launch,** silently. Warnings appear only when something changes, such as an expiring Claude login (`loginExpiresAt`), a logged-out CLI or a version too old for the adapter.

## 15. Security

- **Network.** The server and runner listen on **127.0.0.1 only** by default. A per-install random token is required on every local HTTP, WebSocket and MCP request. Network access for phones and tablets is opt-in (§15.1).
- **Request checks.** `Origin` and `Host` headers are checked, which blocks other websites and DNS rebinding from reaching the local API. While network access is on they also accept the machine's own LAN and VPN addresses on the server port, and nothing else.
- **The UI token.** It's delivered once through the launch URL and then held in an HttpOnly, SameSite=Strict cookie.
- **MCP tokens** are per session and role-scoped, and revoked when the session ends.
- **Agent environments.** Agent processes inherit the user's environment minus CodeDen's own secrets. Tokens are never logged or written into transcripts.
- **Approvals.** Risky-action approvals follow §11.2. The orchestrator and PMs can't write project code.
- **Remote access** (phone, tablet, LAN, the user's own VPN) is opt-in and password-protected; see §15.1.

### 15.1 Network access (decided 2026-11-08)

The owner can open CodeDen from a phone or tablet on the same network or over their own VPN (Tailscale's `100.64.0.0/10` is recognised). v1 is deliberately small: a password, sessions, plain http.

- **Off by default.** With it off nothing changes: the HTTP listener binds 127.0.0.1 and only the install token works.
- **Turning it on** (Settings › Network access, `PUT /api/network`, or `codeden network on`) needs a password and moves **only the HTTP listener** to `0.0.0.0` on the same port. The HTTP server takes its connections from a swappable TCP listener, so open connections, the UI WebSockets and the runner carry on; off moves it back and drops remote connections. The server refuses to bind beyond loopback without a password, at startup too. The desktop app behaves the same (its server is the same `startServer`).
- **Password.** At least 15 characters; very common passwords, repeats and sequences are refused (`passwordProblem` in contracts, shared by the UI and the server). **Generate** returns a five-word passphrase once. Stored only as a salted **scrypt** hash in `<home>/remote-access.json` (mode 0600), kept out of `settings.json` so the settings API can't switch access on. Changing it signs out every remote device.
- **Who is remote.** The socket's peer address: anything but `127.0.0.0/8`, `::1` and their IPv4-mapped forms. Forwarding headers are never read.
- **Sign-in.** Remote devices without a session get the SPA shell (public, it is the open-source bundle), whose API calls answer `401 sign_in_required`, so the UI shows a mobile sign-in page. `POST /api/auth/sign-in` sets a random 90-day session token in an HttpOnly, `SameSite=Lax` cookie (`Secure` over HTTPS); only its SHA-256 hash is stored, with the user agent and last-seen time. Failed attempts are throttled per address (free for three, then 1 s doubling to 30 s; ten in 15 minutes lock the address for 15 minutes; in memory) and logged with the address to `logs/remote-access.log`.
- **Reachable remotely:** the UI, the HTTP API and the UI WebSockets (`/ws`, `/ws/pty`, `/ws/browser`), behind the session. **Never reachable remotely:** `/mcp` (404 to remote peers), the runner and its MCP proxy (always 127.0.0.1), and network management (the switch and the password are loopback-only; remote devices see the status and can sign devices out). The install token is never accepted from a remote peer.
- **Signed-in devices** are listed with Sign out and Sign out all; revoking closes remote connections so the device notices at once.
- **Plain http.** There is no certificate for a LAN address, so phones allow no service worker, push notifications or microphone there; CodeDen ships a manifest and icons for Add to Home Screen, but no service worker. HTTPS (for example behind the user's own reverse proxy) is a later step.

## 16. Distribution and operations

- **Install.** `npx codeden` (or `npm i -g codeden`), or the desktop app's installer from GitHub Releases (§17). The CLI subcommands:
  - `codeden` (start and open)
  - `codeden doctor` (diagnostics, including installed versions and which one starts)
  - `codeden update` (install the latest version and switch to it), `codeden update --rollback`
  - `codeden stop`
  - `codeden password [--generate]`, `codeden network on|off` (network access, §15.1)
  - `codeden --port`, `--home`
- **Updates: one click, side by side.**
  - **Check.** On server start and every 6 hours the server asks the npm registry for `codeden`'s `latest` dist-tag (only the package name is sent). The status is served at `GET /api/updates` and pushed live as an ephemeral `update` WebSocket message (like runner status, not in the event log). Setting `updates.mode`: `off`, `notify` (default) or `auto` (download in the background; it starts on the next launch, or now with "Restart now").
  - **Install.** "Update now" runs `npm install codeden@<version> --omit=dev --no-audit --no-fund` into a staging folder under `<home>/app`, checks the result (package version, entry files, and the installed CLI answering `--version`), then renames it to `<home>/app/<version>/`. A lock file serialises installs (server and `codeden update`); progress lines stream to the UI. The running version's files are never touched (Windows locks loaded native modules). `<home>/app/current.json` (`AppPointer`: version, previous) then names the new version; older versions are pruned to the pinned one and its previous.
  - **Launcher.** Every copy of the CLI (npx cache, global install, side-by-side version) runs a small launcher first: when `current.json` names a valid installed version newer than itself, that version's `dist/cli.js` is loaded with `import()` in the same process, so arguments, environment, signals and exit codes are unchanged and no extra process is left. A missing or broken pinned version falls back to the launched copy with a warning (stderr, About, `doctor`). A newer global install wins over an older pin. Builds from a source checkout (the package root still has `src/`) never switch; the UI says to pull and rebuild.
  - **Version at runtime.** The published entries set the version from their own `package.json` before loading the bundle, so the package version is the single source of truth (`SOURCE_VERSION` in contracts is kept in sync for the workspace).
  - **Restart.** After the install the server announces `restarting` and calls the CLI's restart hook: the CLI closes the server (the runner keeps running), starts the new version's CLI as a child in the same terminal with the original arguments plus the port in use and `--no-open`, and stays as a thin parent that passes on signals and the exit code. The new server finds the old runner, sees the version mismatch and drains it (§4.2), so interrupted turns resume through the existing path. The browser polls `/api/health`, reloads when the new version answers (same port and install token, so the cookie still works) and confirms "CodeDen updated to X". If the new version exits before answering, the CLI restores `current.json`, records the failure (`<home>/app/last-update.json`) and starts the old version again; the UI shows the error with Retry. A server not started by the CLI (development) cannot restart itself and shows "Update installed, restart CodeDen to finish" with the command.
  - **Rollback.** About and `codeden update --rollback` point `current.json` back at the previous version (or clear it to run the launched copy) and restart.
  - **Tests.** `CODEDEN_UPDATE_REGISTRY` and `CODEDEN_RELEASE_NOTES_URL` point the check, the install and the release notes at a local fake registry; they exist for tests only.
  - **The desktop app** (§17) uses the same setting, the same 6-hour schedule and the same banner, but not npm: the server's update service runs in desktop mode (`InstallSource` `desktop`, `DesktopUpdateService`) and drives the app's updater (electron-updater, GitHub Releases) over IPC. "Update now" downloads with progress, then the app stops the runner gracefully (as `codeden stop`), installs and restarts; sessions resume through the usual path. `auto` downloads in the background and installs on quit. Side-by-side npm versions and rollback don't apply. `CODEDEN_DESKTOP_UPDATE_URL` (tests only) points the app at a local feed.
- **Telemetry.** None. CodeDen sends nothing anywhere; the only outbound requests are the optional update check (the npm registry, or GitHub Releases in the desktop app), the release notes from GitHub when you open "What's new", and downloads you start yourself (Claude Code support, local Whisper).
- **Native dependencies.** Kept to `node-pty` and `@napi-rs/keyring`, both with prebuilt binaries. Installing through `npx` on Windows, macOS and Linux is checked in CI. The local Whisper runtime (§11.3) is a native addon too, but it is not a package dependency: it is downloaded on demand, checksum-verified, only when the user turns local dictation on.

## 17. The desktop app (Electron)

`apps/desktop` is a thin Electron shell that starts the same server and loads the same UI. The seams that keep it thin stay mandatory:

1. The server is started through `startServer(...)` and never imports Electron.
2. The UI talks to the server only over HTTP and WebSocket, with a configurable base URL and token.
3. Platform features go through `PlatformBridge` (§13).
4. Agents use the browser only through CDP. This is what lets native browser views be driven through a per-session relay instead of a debugging port.
5. Secrets are already in the OS keychain.
6. Native dependencies are kept minimal and Node-API (they load in Electron without a rebuild).

**Processes.** The main process (TypeScript, bundled with tsdown) owns the window, tray and updater. It uses the same home as `npx codeden` (`~/.codeden`): if a live server for that home exists (lock file, live pid, `/api/health`) it attaches to it; otherwise it forks `dist/server.js`, the same server the CLI ships, on its own binary as Node.js (`ELECTRON_RUN_AS_NODE`, the helper binary on macOS), on port 4317 or any free port. No system Node.js or npm is needed. Every place that starts CodeDen's own scripts with `process.execPath` (the runner, npm, Playwright's CLI) adds `ELECTRON_RUN_AS_NODE` explicitly; the server and runner remove it from their own environment so shells and agents never inherit it, and npm-style shims of the user's tools run on the user's `node` when there is one. The runner stays detached. Server and main talk over Node IPC with `DesktopServerMessage` / `DesktopHostMessage` (contracts). Quitting closes the server and leaves the runner running; a server stopped from outside (`codeden stop`) quits the app.

**Window and bridge.** One window on the server's UI, loaded through the token launch URL (the cookie bootstrap as in the browser). `contextIsolation`, `sandbox`, no `nodeIntegration`, navigation locked to the server origin (other links open in the system browser), permissions limited to notifications, the microphone (audio only), the clipboard and fullscreen for the server's pages. The app has no debugging port: browser views are reachable only through a separate local connection for each session (Phase 2), which never exposes the CodeDen window. The preload exposes only `window.codedenDesktop` (`CodedenDesktopApi`: info, folder picker, notifications with click-through, open external, badge, navigation, and `browser` to place native views), validated in the main process. The Chromium profile and window state live in `<home>/desktop`, so a separate `--home` is a fully separate app; one instance runs per home.

**App integration.** A tray (menu bar on macOS) with running and waiting counts from `GET /api/activity` (counts by session status, never by provider), the app icon badge, native notifications, the system folder picker, `codeden://` links (`session/<id>`, `project/<id>`, `inbox`, `settings/<section>`), keep-awake (`powerSaveBlocker`) while an agent runs, open at login, close to tray, and an application menu with the standard roles, except zoom: CodeDen's own items (50% to 200% in 10% steps, Ctrl/Cmd with `=`, `+`, `-` and the numpad keys) keep the level with the window state and apply it again after every navigation. Its settings are a `desktop` section in `Settings` (launch at login, close to tray, keep awake), read by the app by polling the server.

**Claude Code support** is installed on demand without npm (`CODEDEN_DEPS_INSTALLER=registry`): the pinned SDK tarball is fetched from the registry, checked against the manifest's sha512 integrity and unpacked into `<home>/deps`. It is never bundled.

**Updates** (see §16): electron-updater against GitHub Releases, driven by the server's update policy, so the existing banner works unchanged. Installing stops the runner first (it may run from the install folder, and Windows locks files in use). When attached to a server started by `codeden`, the app follows the update mode on its own (tray and a notification). macOS updates need a Developer ID signature; unsigned builds say so instead of offering updates.

**Packaging and release.** electron-builder from a staged app (`dist/` plus the runtime dependencies installed with npm, no asar): NSIS per-user (no admin, Start menu and desktop shortcuts, uninstaller), dmg + zip for arm64 and x64 (the zip feeds the updater), AppImage + deb. Signing is optional through `CSC_LINK`/`CSC_KEY_PASSWORD` and notarization through `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`; without them Windows builds are unsigned (SmartScreen warns) and macOS builds are signed ad hoc (Gatekeeper asks the user to allow the app once; an unsigned macOS app would be reported as damaged), which the release workflow verifies on the downloaded dmg and zip. The release workflow builds all three on a version tag after the npm publish and attaches the installers and `latest*.yml` metadata to the same GitHub Release. The desktop version always equals the CLI version.

**Phase 2: native browser.** The browser panel shows real browser views instead of the screencast (§12.2):

- **Views.** One `WebContentsView` per tab, laid over the panel and kept in sync with its bounds. Each CodeDen session gets its own session partition, so cookies and storage stay isolated.
- **Agent access.** A per-session CDP relay in the main process (built on `webContents.debugger`) gives the runner a local CDP connection that sees only that session's views. The runner's agent primitives (aria snapshot, click by ref, screenshots, logs) work unchanged.
- **No app-wide debugging port.** One would expose the CodeDen window and merge every partition into one context.
- **Tabs** are created by the app, not over CDP (Electron can't create targets over CDP); the relay asks the app for a new view.
- **Removed views** must not leave agent calls hanging: the relay fails pending screenshots and commands when a view goes away.
- **Quitting the app.** Each open tab of a running session moves to the runner's own Chromium, at the same URL and with its cookies; unsaved form input in the page is lost. When the app opens again, those sessions stay on the runner's Chromium, and browsers opened from then on use native views.

Settled in the implementation:

- **Views.** In-memory partitions (no `persist:`), freed once a session has no tabs and no runner connected, like a closed runner context. Views are hidden with `setVisible(false)` and never removed while they live (removed views stop answering captures); `backgroundThrottling` is off, so agents keep working in background tabs, a closed panel and a window hidden in the tray. A fresh view loads `about:blank` before its debugger attaches (a view with no renderer never answers CDP).
- **Placement.** The panel renders an empty host box. Every animation frame it measures itself (`getBoundingClientRect`) and sends the box over the bridge when it or the pixel ratio changed; the main process scales it by the window's zoom, rounds each edge to whole pixels and clips it to the window. Polling one rectangle per frame follows resizes, sidebar and panel toggles, layout animations, zoom and moves between screens without tracking each cause. The view hides when the box has no size, the window is hidden, the tab changes or the panel unmounts.
- **Overlays.** A native view paints over the whole page. Every element mounted straight into `body` outside the app (menus, popovers, tooltips, dialogs and the palette portal there) and every toast counts as an overlay; while one overlaps the view, the view is captured, the still is shown in its place, then the view hides, and it comes back when nothing overlaps. Toasts move to the bottom left while a native view is on screen, so they rarely trigger this. One rule in one place, instead of each menu knowing about the browser.
- **The relay.** One loopback WebSocket listener in the main process, a `/cdp/<sessionId>` path per session and a random 256-bit secret per session in the `x-codeden-relay-secret` header (never in a URL, so never in a log). Requests with an `Origin` header (any web page) or from another host are refused. It emulates the browser-level calls `connectOverCDP` makes (flattened auto-attach, `Target.createTarget`/`closeTarget` through the app, `attachToBrowserTarget` plus `attachToTarget` for extra sessions) and forwards page sessions to the view's `webContents.debugger`; child sessions (out-of-process frames, workers) are routed by their ids. It swallows Playwright's media emulation, so a view keeps the user's colour scheme. **Why a loopback socket and not Node IPC through the server:** playwright-core needs a CDP WebSocket endpoint, a snapshot is many CDP round trips that would each cross two processes, and an app attached to a server started by `codeden` has no IPC channel to it.
- **Server and app.** The app connects to `/ws/browser-host` (loopback only, install token), so it works whether it started the server or attached to one. The server asks it to `attach` a session and passes the relay to the runner in `browser.open`; on quit the app sends `handoff` (tabs and cookies) and the server runs `browser.handoff` for each session. Native browsers live in the app, not the server: a server restart doesn't touch them, and the runner adopts a session's existing views when it connects again.
- **Toolbar.** The address bar, history, tabs and dev servers go through the same server routes as the screencast, reaching the view through the runner and the relay, so the runner stays the one owner of tab ids and the active tab for agents, phones and the desktop panel alike. The bridge only does what the UI can't: place and hide views, capture a still, open DevTools (**⋯ › Inspect**), and hand back CodeDen's own shortcuts pressed inside a view.
- **Remote viewers.** A phone or browser tab of a native session gets the runner's screencast of the view through the relay. The view's size is fixed by the desktop panel (`browser.viewport` answers `fixed`), so every remote viewer fits the frames.
- **Security.** Views: `sandbox`, `contextIsolation`, no `nodeIntegration`, no preload, no `<webview>`. Only clipboard writes are granted; camera, microphone, location, notifications, devices and fullscreen are denied. `chrome://`, `devtools://`, `edge://`, `file://` and `javascript:` are refused for page navigations, redirects, new tabs and the relay's `Page.navigate`. Downloads go to the OS Downloads folder without overwriting. The user agent drops the Electron and app tokens. Popups become tabs of the same session, keeping `window.opener`.
- **No hand-off.** If the relay drops without one (the app crashed, or quit with no server to take the tabs), the runner reopens the tabs it last had in its own Chromium, without cookies.

Browser speech recognition doesn't work inside Electron, so dictation there uses local Whisper (§11.3) or a cloud engine; the UI finds this out by feature detection.

## 18. Testing

- **Unit tests** (Vitest): the event reducer, projections, the tool registry, the autonomy policy classifier, the scheduler and the runner protocol.
- **Provider tests** run against the **Replay** provider, with sessions recorded from the real CLIs. A small set of live smoke tests runs on demand.
- **End-to-end** (Playwright): first-run setup (with CLIs faked), starting a session, approvals, the inbox, voice controls (mocked) and the browser panel, all driven by the **Fake** provider.
- **CI:** Windows, macOS and Linux, including an install check of the packed npm tarball.

## 19. Milestones

| # | Milestone | Contents |
|---|---|---|
| M0 | Foundations | Monorepo, server, runner, web skeleton, runner protocol and lifecycle, DB and migrations, security token, first-run setup and detection, CI |
| M1 | Daily driver (private use starts here) | Projects (GitHub and local), sessions on Claude and Codex, worktrees and setup scripts, transcript with tool calls and subagent threads, approvals and autonomy levels, checkpoints and diffs, terminal, browser with agent tools and screenshot sharing, memory/skills/subagents/MCP editors, voice, notifications, image generation tool, utility model and follow-up prompts |
| M2 | Orchestration | Usage and cost reports (§12.6), orchestrator and PMs, the MCP tool registry by role, typed notices and wake-ups, inbox, GitHub issue and PR flow, evidence branch, PR and check sync |
| M3 | Automations | Scheduler, event triggers, guards, the template library, issue triage, per-project toggles, custom automations |
| M3b | Autonomy modes (experimental) | Project autonomy modes, the vision editor, the factory loop, merge checks with cross-provider review, automatic merge and revert, limits and kill switch, factory panel and daily digest (§10.1) |
| v1.0 | Public launch | Polish, docs, `npx codeden` release |
| Desktop | Desktop app | The Electron app (§17): installers, tray, notifications, deep links, automatic updates |
| Browser | Browser panel | Phase 1: the full-panel screencast on every surface. Phase 2: native browser views in the desktop app with a per-session CDP relay (§12.2, §17) |
| Later | | OpenCode, ACP adapter, remote runners (Upstash Box, SSH/VPS, Docker), webhooks, GitLab and other forges, remote/mobile access |

## 20. Spikes before M1 (de-risk first)

1. **Runner lifecycle on Windows.** A detached process that survives the server exiting, process-tree kill, the lock file, and draining on upgrade.
2. **Claude Agent SDK** with `pathToClaudeCodeExecutable`: streaming input, `canUseTool`, `resume`, subagent `parent_tool_use_id` events, and an injected MCP server.
3. **Codex `app-server`:** generating TS types, the turn and approval flow, MCP injection, and sandbox behaviour on Windows.
4. **Browser:** Playwright MCP over CDP with several sessions in one Chromium, versus our own tools; and screencast latency in the panel.
5. **MCP Streamable HTTP on Hono,** behind the runner proxy, with token scoping.
6. **Packaging:** installing `node-pty` and `@napi-rs/keyring` through `npx` from a packed tarball on all three operating systems.
7. **Image generation through Codex:** the most reliable way to get an image file back from a headless Codex turn under a ChatGPT login (`app-server` or `exec`), plus latency and failure modes. Also check the Gemini and OpenAI image APIs' current models and parameters.

## 21. Risks

| Risk | Mitigation |
|---|---|
| Provider protocols change (Codex `app-server`, Agent SDK) | Pin tested versions; generate Codex types from the installed CLI; the adapter contract tests run on Replay fixtures; `doctor` reports unsupported versions |
| Terms for using subscription logins inside third-party harnesses | CodeDen never implements its own login; it runs the user's own CLI with its own login. Track Anthropic and OpenAI terms; API keys are a supported alternative |
| Adapters grow large and fragile | Small modules per concern (session, events, approvals, subagents); honest capability flags; Replay tests per adapter |
| Windows edge cases (ConPTY, path length, process trees, Codex sandbox) | Windows tested first; short worktree paths; process-tree kill; spike 1 |
| Scope (the full vision for v1) | Strict milestone order; private use from M1; the "Later" list stays out of v1 |
| Agents acting unsafely in a factory | Default autonomy asks for risky actions; automations off by default; PMs can't write code; everything traceable |
