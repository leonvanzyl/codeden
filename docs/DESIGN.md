# CodeDen: Design

> Status: **locked for v1**, 2026-11-07. Changes to anything in "Locked decisions" need an explicit design discussion and an update to this file. The desktop app (§17) was approved on 2026-11-08. Opt-in network access for phones and tablets (§15.1) was approved on 2026-11-08. The software factory and dark factory redesign (§10.1) was approved on 2026-11-11. Remote runners in sandboxes (§4.2, [remote-runners.md](remote-runners.md)) were proposed on 2026-11-12; the network questions in §15.2 await the user's decision.

## 1. What CodeDen is

CodeDen is a local-first harness for coding agents (Claude Code, Codex, OpenCode, Cursor and Gemini CLI, more later). Lead with this: a beautiful, streamlined coding harness that can also run a software factory, and a dark factory that finds its own work. Every piece of work stays visible and traceable in GitHub.

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
| Agents | Claude Code through the **Claude Agent SDK**, using the user's installed `claude` binary. Codex through **`codex app-server`** (JSON-RPC, with types generated from the installed Codex). OpenCode through a private **`opencode serve`** per session (its v2 HTTP API and event stream). Cursor through its CLI's **`agent acp`**, driven by a generic **ACP** (Agent Client Protocol) client that other ACP agents can reuse; Gemini CLI through **`gemini --acp`** on the same client. In a sandbox the same adapters run inside the remote runner; batch modes (`claude -p`, `codex exec`) are not used |
| Agent ↔ app | One internal **MCP server** (Streamable HTTP) with **role-scoped tokens** (orchestrator, PM, agent) |
| Process model | **Server and runner are separate processes** from day one (§4). The server can drive several runners: the home runner next to it, and one per sandboxed session (§4.2) |
| Execution backends | `local` (worktrees on this machine) is the default and needs nothing extra. Opt-in per project or session: `docker` (plain Docker Engine, a container per session) and `upstash-box` (a box per session). The whole runner runs inside the sandbox and clones the repo there ([remote-runners.md](remote-runners.md)) |
| Terminal | node-pty in the runner, xterm.js in the UI |
| Default autonomy | **Auto, risky actions ask** (§11.2). Overridable per project and per session |
| Image generation | A pluggable `generate_image` tool available to every agent. Engines: Codex (the default when Codex is logged in), Gemini image models, OpenAI Images. Chosen in Settings (§12.5) |
| Utility model | One small, cheap model setting for side jobs: follow-up suggestions, read-aloud summaries, session titles (§7.4) |
| v1 scope | The full vision: daily driver, orchestration, automations (§19) |
| Projects | GitHub repos get the full issue/PR/evidence flow. **Local-only folders are supported** without the GitHub features |
| Forges | GitHub only in v1 |
| Platforms | Windows, macOS and Linux. **Windows is tested first** |
| Network exposure | The runner, its MCP proxy and the server's `/mcp` listen on or answer **127.0.0.1 only**, always. The server's web UI, HTTP API and UI WebSockets are 127.0.0.1 only **by default**; **opt-in network access** (decided 2026-11-08, §15.1) moves just that HTTP listener to `0.0.0.0` on the same port, behind a password sign-in, for phones and tablets on the LAN or the user's own VPN. Sandboxed runners are reached through an exec link, which changes nothing here; any listener for remote runners **needs the user's decision** (§15.2) |
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
- **Event journal.** The runner keeps events locally until the server acknowledges them by sequence number, so nothing is lost while the server is away. Streamed deltas for one item are batched (up to about 50 ms) before they're journaled, and acknowledged events are compacted out of the journal lazily rather than on every ack.
- **Non-interactive agents.** The runner opens every agent session with `CI=true` in its environment, because an agent's shell has no terminal: a command that asks a question, such as pnpm's "The modules directory will be removed and reinstalled from scratch. Proceed?", would wait forever. A `CI` the user's environment sets is kept (`CI=false` opts out), and a value the server passes in `SessionOptions.env` wins. Terminals and setup scripts are unchanged. Inside agent sessions, the user's own tools behave as they do in CI:
  - **Playwright:** `reuseExistingServer: !process.env.CI` starts a second dev server, which fails when one is already running; `forbidOnly: !!process.env.CI` fails on `.only`; `retries: process.env.CI ? 2 : 0` retries flaky tests quietly.
  - **Installs:** pnpm uses a frozen lockfile; Yarn Berry's `enableImmutableInstalls` defaults to true, so `yarn install` fails after an agent edits `package.json` instead of updating the lockfile.
  - **Builds and tests:** Create React App and similar builds treat warnings as errors; test runners don't write new snapshots; other tools switch to CI reporters or skip interactive setup.

  So it's a **project setting** (`Project.agentCiEnv`, on by default, Settings → General → Agent environment, or the orchestrator's `update_project`). When it's off, the server sends `SessionOptions.ciEnv: false` and the runner adds no `CI`; a `CI` from the user's environment or `SessionOptions.env` still reaches the agent. It applies when a session opens (start or resume), so running sessions keep theirs. Turning it off doesn't touch pnpm's `confirmModulesPurge: false`, which a repository sets in its own `pnpm-workspace.yaml` (CodeDen's does) so pnpm never asks before purging `node_modules`, with or without `CI`.
- **Upgrades.** On a version mismatch, the runner drains. It finishes or pauses turns, then restarts. Sessions are resumed through their provider's resume support, with an automatic "you were interrupted, continue" message when a turn was cut off.
- **Remote runners** ([remote-runners.md](remote-runners.md), phased). The same runner package runs, whole and unchanged, inside a sandbox: a Docker container or an Upstash Box, one per agent session. An **execution backend** makes, pauses and deletes sandboxes. The server reaches each sandboxed runner through an **exec link**: it starts `codeden runner-link` inside the sandbox through the backend's own stdio channel (`docker exec -i`, Upstash `exec.session`), which splices to the runner's loopback WebSocket. No listener is opened anywhere, and a dropped link costs nothing because the runner keeps journaling. In a sandbox the runner clones the repo into a path it chooses instead of making a worktree in `<home>/wt`. The orchestrator and PMs stay on the home runner next to the server. A design spike ran the packed runner in a Linux container with the Fake provider over both an exec link and a dial-out link.

### 4.3 Runner protocol

A versioned, zod-typed message protocol over one connection (a WebSocket, or an exec link for a runner in a sandbox):

- **Server → runner commands:** `workspace.prepare`, `session.start`, `session.send`, `session.steer`, `session.interrupt`, `session.respond` (approval or answer), `session.stop`, `pty.*`, `browser.*`, `git.*`, `mcp.test` (an MCP server connection test, §12.4).
- **Runner → server events:** normalized agent events (§7.3), process status, terminal output, browser frames. Each event carries a monotonically increasing `seq`, which the server acknowledges. Provider lists (with each provider's models) are sent at the handshake and again whenever a list changes, for example once model discovery finishes.
- **Handshake:** the protocol version, runner version and capabilities are exchanged on connect.
- **Transports.** The protocol is JSON messages and doesn't depend on the carrier. The server reaches a runner through a `RunnerTransport` ([remote-runners.md](remote-runners.md) §6):
  - `loopback`: the local runner's `127.0.0.1` WebSocket, found through its lock file.
  - `exec`: newline-delimited JSON, one message per line and at most 16 MiB a line, on the stdin and stdout of `codeden runner-link`, run inside a sandbox (§4.2). The link writes nothing else to stdout. It exits with distinct codes when no runner is running (3) and when the runner refuses it (4).
  - A `dial-out` transport, where the runner connects to the server, is deferred to the §15.2 decision.
- **`welcome` reports where the runner runs:** `platform`, `arch`, `home` and `backend`, all optional so older runners still connect.
- **Workspaces on a runner's own disk** (built, [remote-runners.md](remote-runners.md) §9, §10):
  - `workspace.prepare` has a `clone` strategy. A runner whose `welcome.backend` isn't `local` clones the project's `origin` into `<runnerHome>/ws/<session>`, a path it chooses, and the session's `cwd` is that path, shown as is. Local runners keep worktrees.
  - `fs.list/stat/read/write` (at most 4 MiB a call) and a chunked, pull-based `transfer.*` stream. The server reads and writes a session's files through a `WorkspaceFs`: its own disk for the home runner, these commands for every other runner. It picks by its own runner record, never by what a runner reports. Both sides refuse the same paths with the same codes: anything outside the root (by text, then through links), CodeDen's credential files and their `.invalid-*` copies, writes to agents' allow-lists and inside `.git`.
  - `browser.screenshot` returns the PNG instead of writing a path on the server's machine.
  - `workspace.prepare` (clone, fetch) and `git.push` take a brokered git credential for that one operation (§15.2).
  - A command whose working folder is gone fails with `cwd_missing`.
- **Planned for remote runners** ([remote-runners.md](remote-runners.md) §18):
  - `mcp.request`/`mcp.response` frames tunnel MCP (§4.4).
  - `runner.credentials` delivers provider credentials into runner memory after each handshake.

### 4.4 MCP access path

Agents always call a **local MCP proxy inside the runner** (`http://127.0.0.1:<runnerPort>/mcp`), with the session's scoped token. A local runner's proxy forwards over HTTP to the server's loopback `/mcp`. A sandboxed runner's proxy tunnels each request over its runner link instead, and the server answers it in-process with the same token check, so `/mcp` stays loopback-only. Locally and remotely, agents see the same localhost address and nothing extra is exposed.

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
    providers/  provider adapters (claude, codex, opencode, later acp, fake, replay)
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
  - `agent-config/disabled-hooks.json`: hooks switched off on the Agents page, until they are enabled again (§12.4).
  - `logs/`
- **Secrets** (an optional ElevenLabs key, API keys if a user chooses that mode) live in the **OS keychain** through `@napi-rs/keyring`, never in files. GitHub and provider credentials are inherited at runtime, not stored (§14).
- **Event log.** Append-only `events` table (`seq`, `session_id`, `type`, `payload`, `ts`). **It's never pruned**: it's the audit trail and the replay source.
- **Projections.** `projects`, `sessions`, `threads`, `turns`, `items`, `inbox_items`, `automations`, `automation_runs`, `github_issues`, `github_prs`, `artifacts`, `item_search`. They're written in the same transaction as the event that produces them, so they can be rebuilt from the log.
- **Transcript search.**
  - **What's indexed.** `item_search` holds each item's searchable text: prompts, replies and plans, command lines, file paths read or edited, search and web queries, subagent tasks and results, questions and answers, approvals, notices and errors. Reasoning, tool output, diffs and todo lists are left out, and an item contributes at most 16,000 characters.
  - **The index.** An FTS5 index (`item_search_fts`, built into `node:sqlite`) covers that text with the trigram tokenizer. It keeps only which rows hold each trigram (`detail=none`), about a quarter of the size of an index with positions. A row's id is its item's rowid in `items`, so the index lists matches in the order items were created. Triggers keep the index in step with `item_search`, and the thread, kind and time of a match are read from `items`.
  - **Matching.** Every term of the query must appear, in any order, as a substring of the item's text, ignoring case and accents, so matches land inside identifiers and paths. The index finds the items holding every trigram of the terms, tokenized by the index's own tokenizer (so case, accents and combining marks are treated exactly as in the indexed text). Search then checks each candidate's text for every term, short ones included, with the same case and accent folding. A query needs at least one term of 3+ characters, and control characters in it are ignored.
  - **When it's written.** The row is written alongside the item, except for streaming deltas. An item is indexed when it starts, updates and completes, and again when its turn ends, which catches a reply cut off mid-stream.
  - **The backfill.** Items the index hasn't seen are indexed in the background once the server listens: databases from before search existed, and items an older build wrote in between. It reads `items` in rowid order, 500 items per transaction, and saves where it got to (`item_search_backfill`) in the same transaction, so a backfill cut short continues on the next start. It logs its progress. Until it finishes, search returns what is indexed so far.
  - **The API.** `GET /api/search/transcripts` returns the newest matches first, a page at a time: `nextCursor` continues below the last item looked at. It filters by project and session role, and leaves out archived sessions when `includeArchived=false` (they're included by default). Each match comes with a snippet and the root-thread item to open. A match inside a subagent's thread opens that thread at the item, beside the subagent card that started it. Matches stream newest first from the index, and a request stops once it has a page, after at most 2,000 candidates, so a search never holds up the server for long.
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
  forkConversation?(resumeToken: string, opts: { cwd: string; upTo?: string }): Promise<string>; // with `fork`
}

interface ProviderSession {
  events: AsyncIterable<AgentEvent>;          // normalized (§7.3)
  send(input: UserInput): Promise<void>;      // starts a turn
  steer?(input: UserInput): Promise<void>;    // inject into a running turn
  interrupt(): Promise<void>;
  respond(requestId: string, response: RuntimeResponse): Promise<void>; // approvals, questions
  setPlanMode?(on: boolean): Promise<void>;   // plan mode on/off (capabilities.planMode, §11.2)
  close(): Promise<void>;
  resumeToken(): string | undefined;          // provider session/thread id for resume
}
```

**`ProviderCapabilities` flags:** `resume`, `steer`, `interrupt`, `approvals`, `userQuestions`, `subagents`, `rollback`, `fork`, `images`, `planMode`, `reasoningEffort`, `mcp`, `skills`, and two optional ones (absent counts as false):
- `liveAutonomy`: an autonomy change reaches a running turn from its next tool call; without it, a running turn keeps its level and the change applies from the next turn.
- `readOnly`: the `read_only` level is enforced natively (no file edits, no writing shell commands, no commits or pushes, §11.2); without it, the provider's sessions can't use `read_only`.

**Forking.** An adapter with `fork` implements `forkConversation(resumeToken, { cwd })`. It copies that conversation into a new one at once and returns the copy's resume token, which a session then resumes like any other. The original conversation is never written to. The runner exposes it as `provider.fork`. `SessionOptions.forkFrom` does the same as a session opens: the adapter copies that conversation and the session resumes the copy. A `resumeToken` wins over it, and a provider without `fork` refuses it. An adapter that can stop a copy partway reports a `forkPoint` on a root turn's end event (`turn.completed`, `turn.failed`, `turn.interrupted`), an opaque position in its conversation. `forkConversation` with `upTo: forkPoint` copies through that turn and no further. When the conversation no longer holds that point (it was replaced or deleted), it throws `fork_point_missing` before copying anything, never falling back to the whole conversation; the runner reports that code as it is and every other failure as `fork_failed`.

### 7.2 Providers

- **Claude Code.** Uses the Claude Agent SDK `query()` with streaming input:
  - **Binary:** `pathToClaudeCodeExecutable` points at the user's installed `claude`, which inherits their login and settings.
  - **Approvals:** `canUseTool` maps to approvals, and `resume` handles sessions.
  - **Fork:** the SDK's `forkSession()` copies the transcript into a new session file (fresh message ids). No CLI starts and no turn runs. A root turn's fork point is the `uuid` of its last main-chain message (an `assistant` or `user` message without `parent_tool_use_id`), and `upTo` becomes `forkSession({ upToMessageId })`. The transcript is read first (`getSessionMessages`) to confirm it still holds that message. Meta and synthetic messages, which that read may leave out, are never fork points.
  - **Subagents:** messages tagged with `parent_tool_use_id` become child threads.
  - **CodeDen tools:** CodeDen's MCP proxy is passed in through `mcpServers`.
  - **Versions:** the SDK version is pinned to one we've tested against.
- **Codex.** Starts `codex app-server` and speaks JSON-RPC:
  - **Methods:** threads, turns, items, approvals and steering. A fork is `thread/fork` through a short-lived app-server, closed before the copy is resumed. The session that resumes it sets its own cwd, policy and instructions. A root turn that Codex ends (`turn/completed`) has its turn id as its fork point, and `upTo` becomes `lastTurnId`. A turn the thread no longer holds, or a deleted thread, is `fork_point_missing`: from `thread/turns/list` when it can list the thread, or else from `thread/fork`'s own answer (`turn not found`, `no rollout found`). A short-lived app-server usually can't list a thread it hasn't loaded (`thread not loaded`), so `thread/fork` mostly decides. Other refusals, such as a turn still in progress, stay `fork_failed`. A turn CodeDen closes itself (the process died) reports none.
  - **Types:** protocol types are generated from the installed Codex version.
  - **Permissions:** sandbox and approval policies map onto CodeDen's autonomy levels (§11.2).
  - **Subagents:** an agent Codex spawns (a `collabAgentToolCall` spawn, or a `subAgentActivity` start) becomes a subagent card, and the spawned agent's thread, whose notifications arrive under its own thread id, becomes the card's child thread. The card follows the agent's turns, its approvals go to the child thread, and its calls to other agents (message, wait, close) show as tool calls named after their targets. Threads no spawn claims are not shown.
  - **CodeDen tools:** the MCP server is injected through config overrides.
  - **The user's Codex apps** (`vendorHistory`): the Codex apps list every thread in the user's Codex home as the user's recents, and every thread `app-server` starts is one, so CodeDen keeps its threads archived whenever none of their turns runs. It archives a thread when a root turn ends, when the session closes, and a fork's copy as it is made. Codex resumes or forks an archived thread only once it is unarchived, and archiving unloads a thread from its app-server, so CodeDen unarchives a thread right before it resumes or forks it, including before each new turn. A session whose agent spawned sub-agents is archived only when it closes, because unloading the thread could cut off agents a later turn still talks to. A `turn/start` that fails archives the thread too. When the app-server that had the thread open dies (mid-turn, or holding a sub-agents' thread), a short-lived app-server archives it, and the next start waits for that. A killed runner archives nothing, so when a runner starts or reconnects, the server's recovery ends with a sweep: `provider.history.list` and `provider.history.hide` for the threads of sessions on that runner that ran since their provider hides as it goes (marked in the session's start metadata). Sessions that may be mid-turn are skipped (busy by status, hosted by the runner, being started or sent a message). Ephemeral threads are never listed, but a later app-server can't resume them, so only one-shot calls (utility model, image generation) use them. Threads from before this are hidden from Settings → Providers. The runner's `provider.history.list` reports which of CodeDen's recorded threads (its sessions' resume tokens, never guessed from titles) the apps still list, with Codex's own default filter. `provider.history.hide` archives exactly those once the user confirms. Sessions that may be running a turn are left out, and hidden threads stay resumable.
- **OpenCode.** Starts a private `opencode serve --stdio` for each session and speaks its v2 HTTP API, following its Server-Sent Events:
  - **Process:** the server listens on a random `127.0.0.1` port with a per-process password and exits when its stdin closes, so it never outlives the runner. One server per session, because MCP servers are process-wide config and every session has its own role-scoped token.
  - **The user's OpenCode:** it uses their config, credentials and sessions. CodeDen layers an inline config on top with its MCP server (headers, listed directly rather than behind OpenCode's code mode) and a small plugin that keeps the server's secrets out of the agent's shell commands.
  - **Permissions:** OpenCode has no OS sandbox. Every edit, command, path outside the worktree and web fetch asks, and CodeDen's own classifier decides each ask by autonomy level (§11.2): approved on the spot, refused with a reason, or shown to the user. Autonomy changes apply from the next tool call. OpenCode's "always" saves a rule for the whole project, so CodeDen keeps `allow_session` decisions itself.
  - **Sessions:** created in the worktree; CodeDen's role prompt is a session instruction. Steering, interrupt, questions (OpenCode forms) and subagents (child sessions) map onto the event model; OpenCode keeps sessions in its own database, so resume continues the same session after a restart.
  - **Models:** `<provider>/<model>` ids from every provider OpenCode is connected to, with each model's variants as efforts, listed by a short-lived server that never calls a model.
  - **Why not the SDK:** OpenCode's published SDK targets its v1 API; OpenCode 2 serves a different v2 API. CodeDen types the handful of v2 routes it uses (`src/opencode/protocol.ts`), which keeps the published package free of another dependency to pin.
- **Fake and Replay** (development and tests only):
  - **Fake** is a scripted provider for demos and deterministic tests.
  - **Replay** plays back sessions recorded from the real CLIs, so the test suite never pays for agent turns.
- **Generic ACP client** (`src/acp/`). Drives any agent that serves the Agent Client Protocol (version 1) on stdio: JSON-RPC 2.0, one message per line.
  - **Process:** one agent process per session, since every session has its own MCP servers and role-scoped token. `initialize`, then `authenticate` with the agent's own login method when its adapter names one and the agent lists it (the user's existing login; CodeDen holds no credentials), then `session/new` in the worktree. An adapter that names none never authenticates: the agent uses the login it already has.
  - **Resume:** the resume token is the agent's session id, reopened with `session/load` when the agent reports `loadSession`. The agent replays the history as updates first, and CodeDen drops them, since it keeps its own transcript. A session that can't be loaded starts a new one, with a notice.
  - **Events:** `session/update` maps onto the event model. Message and thought chunks become messages and reasoning, `tool_call`/`tool_call_update` (upserted by call id) become tool calls by their kind (`execute` a command, `edit`/`delete`/`move` a file edit with its diffs, `read`, `search`, `fetch`), `plan` becomes the todo list, and `usage_update` and the prompt's token counts become usage.
  - **Permissions:** `session/request_permission` is decided by CodeDen's policy (§11.2), approved on the spot (recorded as `decidedBy: policy`), refused, or shown to the user. Only the agent's "once" options are chosen. Its "always" options would save a rule in the agent's own settings, so CodeDen keeps `allow_session` itself (without a "once" option the call is refused once, or the request cancelled). Calls to CodeDen's own MCP server don't ask, but only calls of kind `other` can be MCP calls: the agent writes titles, so a command or an edit is judged as one whatever it is called. While planning, an ACP `switch_mode` request is the plan approval.
  - **Turns and modes:** interrupt is `session/cancel`, and waiting requests are answered `cancelled`. A Stop while a message is still starting the agent (its handshake, `session/new` or `session/load`, a model switch) ends that turn at once and its prompt is never sent; the agent keeps starting for the next message. The role prompt goes in front of a new session's first prompt, since ACP takes no system prompt. Modes and models are set through the session's config options (`mode`, `model`), else `session/set_mode` and `session/set_model`.
  - **Subagents:** an agent that accepts the `subagents` client capability runs each subagent as a child session. Its `subagent_spawned` (on the parent's session) becomes a subagent card in the parent's turn plus a child thread, and the child's own updates and requests, which arrive under the child's session id, go to that thread: its approvals are decided like the root's and surface in the parent and the inbox. The child's mode, config, command and usage updates are its own and never change the session. `subagent_state_update` (`completed`, `failed`, `cancelled`, `disconnected`) ends the run, with the child's last message as the card's summary and its tool calls and duration as stats; the parent's turn ending closes runs still open. A `session/load` replay never shows them.
  - **Vendor extensions:** methods outside ACP (`<vendor>/<method>`) plug into the session. Requests no extension handles are refused with "method not found", which agents treat as an unsupported feature. Two more hooks read an agent's own conventions: `toolCall` says what its vendor fields (`_meta`) tell about a tool call (the MCP server and tool it calls, the folder a command runs in; an MCP identity counts only for calls of kind `other`), and `permission` answers a permission request the agent's own way (a vendor's plan approval), or leaves it to the policy.
- **Cursor.** Its CLI's ACP server (`agent acp`) through the generic client:
  - **Finding it:** `cursor-agent`, else the first `agent` whose `--version` is Cursor's dated build (`2026.10.22-…`), on PATH and in its installer's folder. Another program called `agent` is passed over and never run with anything but `--version`; sessions and model refreshes only run a copy found this way.
  - **Sign-in:** the login method is `cursor_login`, which reuses `agent login`. `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` in the user's environment also work; CodeDen only checks that they are present.
  - **Models:** `cursor/list_available_models` on a short-lived ACP server (no session, no model call), else `agent --list-models`; a session's `model` option keeps the list current. Cursor lists each effort level as its own model id, so no model has efforts. Choosing a model goes through the session's `model` option, and Cursor saves it as the CLI's default.
  - **Plan mode:** Cursor's `plan` mode. Its `cursor/create_plan` shows the plan and its todos, then becomes the `plan` approval. Approving switches back to `agent` mode and answers `accepted`; declining answers `rejected` with the user's note. Read-only sessions run in Cursor's read-only `ask` mode.
  - **Questions and todos:** `cursor/ask_question` becomes a question card answered with the chosen option ids, and `cursor/update_todos` becomes the todo list.
  - **Subagents:** CodeDen opts into child sessions (`clientCapabilities._meta.subagents`, which Cursor 2026.09.15 and later read, and ACP's own `subagents`), so Cursor's subagents are child threads as above, and `subagents` follows `sessionCapabilities.subagents` in Cursor's `initialize` (detection opts in too). An older CLI only reports a finished task with `cursor/task`: it becomes a subagent card whose thread holds the task and its Task call's result. Where child threads run, `cursor/task` only fills in what a card lacks.
  - **Image generation:** `cursor/generate_image` becomes a tool call with the image Cursor wrote (`generatedImages`), stored and shown like Codex's; a request for a file that isn't there is refused, so Cursor falls back on its own.
  - **The user's chat list:** since CLI 2026.07.06, `agent ls`, `agent --resume` and `/resume` open on all chats across folders, so the chats CodeDen starts are listed there (the Cursor editor keeps its own chats apart and doesn't list them). Cursor has no archive, hide or don't-keep option for a chat, in ACP or the CLI, and deleting one would break `session/load`, so `vendorHistory` stays unset and the behaviour is documented in `docs/troubleshooting.md`. Agent sessions run in worktrees, so the CLI's per-folder view of a project leaves them out.
  - **Not wired up yet:** steering (ACP can't add input to a running prompt), rollback and fork, so those capabilities are `false`. There is no utility model either.
- **Gemini CLI.** Its ACP server (`gemini --acp`) through the generic client:
  - **Finding it:** `gemini` on PATH (npm's global folder), then Homebrew's folders on macOS. CodeDen supports **0.68.0** or later: 0.67 added the MCP server and tool to its permission requests, and 0.68 replays a loaded session's history before answering `session/load`. Detection checks the `initialize` handshake on a short-lived server in a scratch folder of CodeDen's own, without a session (a session would save a session file and start the user's MCP servers and hooks) and without a model call.
  - **Sign-in:** CodeDen never calls `authenticate`, which in Gemini CLI rewrites the login method in the user's settings and clears a cached login of another kind. Sessions use the login the user chose in Gemini CLI (Google, an API key, Vertex AI). Setup reads that choice from Gemini CLI's user settings (`security.auth.selectedType`, or the older `selectedAuthType`; `GEMINI_CLI_HOME` honoured), the Google account's email from `google_accounts.json`, whether `oauth_creds.json` exists, and which login variables are set (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` with `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GEMINI_BASE_URL`): never a credential or a variable's value. A login it can't confirm (a Google login kept in the system keychain, a key in a `.env` file) is reported as unknown, not as signed out. Gemini CLI has no login command; **Sign in** runs `gemini`, which asks how to sign in.
  - **Modes:** agent sessions run in its `default` mode, which asks before every edit, command and MCP tool; a session opening in the user's `yolo` or `autoEdit` default is switched to it, and CodeDen never passes `--yolo` or `--approval-mode`. There is no read-only mode (its `plan` mode refuses CodeDen's own tools), so read-only sessions stay in `default` and the policy refuses edits and commands.
  - **Tool calls:** its permission requests name an MCP call's server and tool in `_meta["gemini-cli"].mcp` (the title is just the tool's name), which is how CodeDen's own tools are recognised. A shell command's folder is read from its `[in <dir>]` detail, so the classifier judges the command where it runs.
  - **Models:** Gemini CLI lists models only in a session (`models.availableModels`). Until one has, the list is Default (Gemini CLI's own setting) plus its aliases `auto`, `pro`, `flash` and `flash-lite`, which always point at its current models. Choosing a model is `session/set_model`. No model has efforts.
  - **Plan mode:** its `plan` mode, where Gemini CLI's own policy allows only read-only tools and writes to its plans folder. Its `exit_plan_mode` permission request (kind `other`, titled "Requesting plan approval for: <plan file>") becomes the `plan` approval, with the plan file shown (a `.md` file in the worktree or Gemini CLI's folder, at most 256 KB). Approving switches CodeDen and Gemini CLI to `default`; Gemini CLI reports no mode changes of its own, so this is how CodeDen hears of it. Declining keeps it planning; ACP can't carry the user's note, so the card says to send it as the next message. While planning, any other `other` tool it asks about goes to the user at every level. `capabilities.planMode` turns off when a session lists no `plan` mode.
  - **Not wired up yet:** questions (Gemini CLI drops its `ask_user` tool in ACP mode), its subagents, steering, rollback, fork and reasoning effort, so those capabilities are `false`. There is no utility model either.

### 7.3 Normalized event model

A conversation is a **thread** made of **turns**, and each turn holds **items**. Agent events:

- **Session and turn lifecycle:** `session.updated`, `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted`.
- **Items:** `item.started`, `item.delta`, `item.completed`. Item kinds:
  - `user_message`, `assistant_message`, `reasoning`
  - `tool_call`, with a `toolKind` of `command`, `file_edit`, `file_read`, `search`, `web`, `mcp`, `browser` or `other`. A call that created images (a provider's built-in image generation) lists their file paths in `generatedImages`, never the bytes; the server stores each one as a session artifact and shows it inline.
  - `plan` / `todo_list`
  - `approval_request`, `user_question`
  - `subagent` (links to a child thread)
  - `notice`, `error`
- **Usage:** `usage.updated` (tokens, cost where reported, rate-limit state).

**Failed turns are classified** by the adapter in `ErrorInfo.kind`: `transient` (overloaded or failing API, dropped connection, the CLI exiting), `usage_limit` (with `retryAt` when the provider says when the limit resets), `context_full`, `auth` or `fatal`. A session the provider refuses to open is classified the same way where the adapter knows why: `setup` (its CLI is older than CodeDen supports) or `auth`; the runner's `open_failed` crash carries it, and the session keeps it as `startError`. Adapters read their own signals (Claude: the turn's assistant error, `api_error_status`, `terminal_reason` and the last rejected rate-limit window; Codex: `codexErrorInfo` and the latest rate-limit snapshot); nothing outside them looks at a provider id.

**Automatic retry** (`settings.sessions.autoRetry`, default on). When an agent session's root turn fails as `transient` or `usage_limit`, the session goes idle with no inbox item, and the server continues it with a `codeden` message ("Previous turn stopped (<reason>); continue where you left off."): after 20 s, 90 s and 5 min for transient failures (at most three in a row), or a minute after a usage limit resets. A notice in the failed turn says when. A user message or Stop cancels a pending retry; pending retries are derived from the turns table, so a restart keeps them. When the retries run out, there is no reset time, or the setting is off, the session fails as before (`failed`, a `run_failed` inbox item and the PM notices that follow). Orchestrator and PM sessions are never retried this way.

**Subagents** are child threads with `parentThreadId` and `parentItemId`. The parent transcript shows a compact subagent card with live status. A finished subagent's item carries `stats` (total tokens, tool calls, duration, and its own calls' tokens per model) when the provider reports them, and the card shows them; providers that report none show none. The card leads with what the run cost: the server prices its tokens per model like a turn (§12.6: reported, estimated from the price table, or not priced; "API-equivalent" for subscription logins), when the session's usage is read, so price edits apply, and the tooltip breaks the cost down by model. Claude streams each call's output count before the call ends, so once a Claude subagent finishes, its transcript (the SDK's `getSubagentMessages`) supplies the final counts and the card is sent again; when it can't be read, the streamed counts stay. The figures, cost included, are display only and never added to usage totals, which come from the provider's own turn figures. Clicking it opens the child thread in a side panel or as its own view, and approvals raised inside a subagent surface in the parent and in the inbox.

### 7.4 Utility model

Small side jobs use one configurable **utility model**, so they never need a separate API key:

- **The jobs:** follow-up prompt suggestions (§13), compressing a final message for read-aloud (§11.3), session titles, short summaries in notices, and the "where it got to" summary in a handoff's brief (§9, `handoffSummaries`: at most 12 lines from a compact transcript, a 45 s timeout, the source's last reply when it's off or nothing answers).
- **How it runs:** a one-shot call through an installed provider with no tools. The default is a small Claude model through the Agent SDK, or a small Codex model when only Codex is set up, or, when only OpenCode is, the cheapest model OpenCode lists from its default model's provider, by listed price (through its text generation endpoint; OpenCode's default model when no prices are known).
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
| Agent | many | Its own worktree and branch, or its own clone in a sandbox (§4.2) | Does the work: code, tests, PRs, evidence |

The orchestrator and PMs always run on the home runner next to the server: they write no code, need little more than MCP, and are long-lived, so a sandbox each would add cost and no isolation.

### 8.2 How work flows

1. **Work arrives.** You ask the orchestrator, a PM picks up a GitHub issue, or an automation fires.
2. **The PM starts an agent session.** It names a provider, model, issue link and brief; CodeDen creates the worktree and branch, then starts the session on the runner.
3. **The agent works.** It may ask questions (inbox), request approvals (inbox), share screenshots, and finally opens a PR with evidence linked to the issue.
4. **Notices wake the PM.** Session events become **typed notices** (`session.finished`, `session.needs_input`, `pr.opened`, `pr.checks_failed`, …). They're batched and debounced, and wake the PM with an "updates since your last turn" summary. A loop guard limits wake-ups: it paces agent-to-agent ping-pong (orchestrator ↔ PM, PM ↔ its sessions) per conversation while no person steps in. Anything the user started goes straight through and clears the counts, and a paced message is queued and delivered automatically, never refused. The guard also records which role-session turns carry the user's own request: the user wrote the message, or the orchestrator passed it on from a turn the user started (`UserInput.relayedForUser`). A turn gets its origin once the runner accepts its input: none while the input is in flight, and a delivery the runner refused leaves the running turn's origin as it was, and one whose outcome is unknown (a timeout or lost connection, after which the turn may have started anyway) leaves the session without the user's authority until a later delivery is accepted (a session takes one delivery at a time; messages sent meanwhile queue). The origin is saved with the session, so a turn the runner keeps through a server restart keeps it; an origin never recorded counts as not the user's. Only such a PM turn may start work on an issue whose author isn't trusted (§10.1): in any other turn `start_session` refuses that issue and `factory_admit_issue` is refused, and the PM raises it in the inbox instead.
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
    - Sessions: `list_sessions`, `start_session`, `message_session`, `stop_session`, `answer_question` (questions from work it, the orchestrator or an automation started; approvals and MCP servers' forms stay with the user).
    - Issues: `list_issues`, `get_issue`, `triage_issue` (labels, comment, accept/decline), `create_issue`.
    - PRs and escalation: `get_pr_status`, `ask_user`, `message_orchestrator`.
    - Automations and notes: `list_automations`, `run_automation`, `read_project_notes`, `update_project_notes`.
    - Factory projects (§10.1): `factory_status`, `factory_admit_issue` (only at the user's request, enforced per turn as in §8.2 step 4), `factory_set_type`, `factory_allow_large_change`, `factory_retry_item` (work let in from an untrusted author only at the user's request, as admit).
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
  - **Deleting safely.** The runner deletes worktree folders itself, never through `git worktree remove`: on Windows Git treats junctions as folders, deleting the contents of whatever a pnpm `node_modules` junction points to and stopping at dangling ones. A folder under `~/.codeden/wt/` is renamed into `~/.codeden/wt/.trash` (all or nothing: if a process holds a file open the worktree stays intact and the removal reports it in use), `git worktree prune` drops the record, and the trash is emptied in the background and on runner start. A trashed folder something still holds (an executable started from it keeps it on Windows even after the move) has its leftovers ended, then is deleted: processes whose paths name the worktree it came from or the trash folder, started before the move (its time is in the trash name), under the same rules as a removal. What started since, or at an unknown time, is kept like a spared terminal, so neither it nor a process it runs under is chosen: nothing in a worktree recreated at that path since is touched, even when an old launcher started it. Symlinks and junctions are unlinked, never followed. A folder under `~/.codeden/wt/<project>/<session>` that is no longer a git worktree (left half-deleted) is removed the same way, and `workspace.prepare` clears one at its target path. Anything outside that folder is deleted only if git lists it as a worktree of the project, and never if it contains the repository or another worktree.
  - **Leftover processes.** Before a removal, and when a session in its own `~/.codeden/wt/<project>/<session>` folder stops, the runner also ends processes it doesn't track that run from or in the folder: executable inside it, working directory inside it (on Windows read from the process's own memory, best effort), or a path inside it on the command line, matched as whole paths (never a sibling with the same prefix). Each is ended with everything it started (`taskkill /T /F` on Windows), so a process is never chosen when something that must survive runs under it: CodeDen, an app a person works in (an editor opened from a shell in the folder), or a spared terminal. Nor is one that runs under such an app, even an app an agent opened: a shell a person works in there, and what they run in it, are theirs (looking up no further than CodeDen's own processes, so the terminal CodeDen was started from, or the desktop app, doesn't make an agent's process a person's). When a session stops, only processes CodeDen's agents or terminals started count: the runner's descendants, and the orphans they leave. On Windows an orphan keeps its parent's pid, so what descends from a process orphaned after the runner started counts (an agent's shell left behind by its CLI). Linux and macOS give an orphan a new parent, so there what the agent started is taken from the runner's descendants just before it stops, and a parent missing from the process table means one the runner can't see (another user's process under `hidepid`, a `docker exec` shell's parent outside the container), never an orphan. Before a removal on Windows, where a process using a folder keeps it from being moved, whatever runs there counts whenever it started (a dev server an agent started before the runner restarted, as after an update), except what a person started from an app they work in: an editor, IDE, terminal or file manager, and everything running under one. Linux and macOS delete a folder while processes use it, so a removal there ends only what CodeDen's agents or terminals started, as on stop, and a person's own shells and dev servers keep running wherever they were started from (SSH, any terminal or editor). The runner, the server and their ancestors are never ended, nor (on stop) the user's CodeDen terminals or a folder another hosted session works in. The server stops every session working in the folder first, a reviewer in its builder's worktree too.
  - **Visible failures.** A removal that fails on a file in use is tried again twice, after 2 and 6 seconds (Windows releases files a moment after their process ends, and each attempt ends what runs there again). One that still fails raises one `cleanup_failed` inbox item per session, naming what still runs in the folder when it can (updated when the reason changes, left alone once dismissed), which CodeDen resolves when a later attempt removes the worktree. The desktop server always writes its log lines to `<home>/logs/desktop-server.log`.
- **Setup scripts.** `.codeden/project.json` can define commands such as `pnpm install`, which run when a worktree is created, plus a dev-server command and the default provider. Setup stops at the first failing command and the session starts anyway; the agent's first input is prefixed with "Setup command `X` failed (exit N):" and the end of the command's output, so it knows why the worktree may be incomplete.
- **Turn checkpoints.** At the end of each turn the runner snapshots the worktree into a hidden ref (`refs/codeden/checkpoints/<session>/<n>`). It uses a temporary index (`write-tree` → `commit-tree` → `update-ref`), so the user's branch and index are never touched. This gives exact per-turn diffs and file-level undo; full rollback is offered only when the provider can also roll back its conversation.
- **Forking a session.** **Fork** (`POST /api/sessions/:id/fork`, the thread header's ⋯ menu, the command palette) copies an agent session into a new one in the same project, so a second approach can run side by side. **Fork from here** on a finished turn's footer does the same from that turn (below).
  - **What is copied:** the provider, model, effort, permissions, plan mode, work key and issue. A fork of a session that is still planning keeps planning and implements only once its own plan is approved; a session waiting for its plan to be approved can't be forked until it's answered. The fork records `forkedFrom` (the source, the checkpoint it started at, and for a fork from a turn that turn and its number among the source's turns, which is what the UI shows: checkpoint numbers can differ from turn numbers when a checkpoint failed to write). The fork is started by the user; when the source's work wasn't (the factory, an automation, a PM or the orchestrator started it, or the source recorded such a starter itself), `forkedFrom.startedBy` keeps that starter, as a handoff does (below).
  - **Code:** the fork's worktree is a new branch created from the source's branch, so it carries the source's real commits and no checkpoint commits. The runner then writes the source's latest checkpoint into it as uncommitted changes, before setup runs (`workspace.prepare` `restoreCheckpoint`). Its pull request targets the source's base branch.
  - **Conversation:** the provider's native fork (`provider.fork`, §7.1). The copy is the fork's resume token from the start, so every start of the fork is a plain resume.
  - **Same moment for both:** the server asks the runner for the source's checkpoints `settled`, which waits for the checkpoint of a turn that has just ended (the runner queues it before it reports the turn's end). Only then does it copy the conversation. If the source moved on meanwhile, the fork fails and nothing is created: a turn still running gives 409 `turn_running`, and a turn that started (even one that already finished, judged by the source's turn count) gives 409 `source_changed`.
  - **No other place to run:** the fork's workspace plan is kept with its start metadata until the worktree exists. If preparing it fails (a restore that fails removes the new worktree again), any later start of the fork, after a message or a restart, prepares it first. A fork never falls back to the repo root.
  - **When:** only when the provider reports `fork`, no turn is running, and the session has a conversation and a git branch. The source is only read. Forking is an explicit, visible duplicate, so it skips the §8.4 conflict check.
  - **From a turn** (`turnId` in the request): a finished turn of the source's own thread. When the turn ends, its adapter reports a `forkPoint` (§7.1), which the server keeps on the turn. The latest turn forks as above (the whole conversation, the latest checkpoint). An earlier turn's copy ends at its fork point (`provider.fork` `upTo`), and its worktree gets that turn's checkpoint, found from the `checkpoints` projection and confirmed with the runner. Neither changes once the turn has ended, so a turn the source runs meanwhile doesn't fail it. The fork fails and nothing is created when the turn isn't the source's (404 `turn_not_found`, or 400 `fork_unsupported` for a subagent's), is still running (409 `turn_running`), recorded no fork point (409 `fork_point_unavailable`, e.g. turns from before CodeDen kept them), or has no checkpoint (409 `no_checkpoint`). When the provider's conversation no longer holds the point (replaced or deleted since the turn ended), the fork fails with 409 `fork_point_missing` and nothing is created; it never falls back to the whole conversation. Other provider failures stay 502 `fork_failed`.
  - **Not yet:** forking a running turn, and rolling a conversation back.
- **Handing a session off.** **Hand off** (`POST /api/sessions/:id/handoff`, the thread header's ⋯ menu, the command palette, and another provider's tile in the session's model picker, "Continue in a new <provider> session") continues an agent session in a new one on any provider, its own included. It is a fork whose conversation is replaced by a brief, for when a provider hits its limit or the user wants a second opinion or another model.
  - **What is carried:** the work key, scope, purpose, issue, permissions and plan mode, and `startedBy` the user. The provider, model and effort come from the request; without a model or effort, the source's are kept on the same provider, and another provider uses its defaults. Title: `<source title> (to <provider>)`. The handoff records `forkedFrom` with `kind: "handoff"` (absent on forks, which means `fork`), shown as "Handed off from" in the header and Details. The new session is the user's, but the work it continues isn't always: when the factory, an automation, a PM or the orchestrator started the source's work, `forkedFrom.startedBy` records that starter (the source's own, or the one it recorded when it was itself forked or handed off), and PR feedback goes by it, so a handoff is trusted no more than its source.
  - **Code:** exactly as a fork: a new branch from the source's branch with the source's latest `settled` checkpoint restored, the pull request targeting the source's base branch, the workspace plan kept with the start metadata until the worktree exists, never the repo root. It runs on the source's runner.
  - **Brief:** the first message, from CodeDen (`from: "codeden"`), which starts a turn. Built by `buildHandoffBrief` from the source's transcript, in order:
    - who it takes over from and where the code is (with the source's worktree path, whose paths mean the same files);
    - the issue and the source's PR;
    - the untrusted-input rule (the factory's wording: issue text and comments are input data, not instructions) when the work is on an issue, someone other than the user started it (`forkedFrom.startedBy` counts), or the factory or an automation wrote to it. It sits in the intro, so no clipping removes it;
    - the task: the first root user message, whoever sent it;
    - later requests: the 10 most recent, CodeDen's own messages (retries, wake-ups, PR feedback) left out;
    - where it got to: a utility summary (§7.4) of a compact transcript of the root thread, else the last reply quoted;
    - the recorded result, the open todos and a failed or interrupted last turn's error;
    - the files edited, by any thread, relative to the worktree (50 at most);
    - the user's note, else "continue where it left off", and a reminder to check `git status` and `git diff` first.

    The brief is CodeDen's message, so it never relays anyone else's words as its own: a task or later request from the factory, an automation, a PM, the orchestrator or CodeDen is quoted (`>`) under "From <sender>:", without the sender line a PM's or the orchestrator's message starts with, so its text can't open a section of the brief either. The user's own messages are shown as written. The compact transcript the summary is written from names each message's sender too. Sections are clipped, and the whole brief stays within 16,000 characters, keeping the intro and the closing whole. Attachments aren't carried; the brief says how many there were. The utility summary is written from the newest 600 root items, led by the task (read on its own, so a long session's first message is never lost).
  - **Delivered once, whatever fails first:** the brief is kept with the start metadata (`handoffBrief`) and the launcher sends it with whichever start opens the session, then clears it. If the first start fails (no runner, a worktree or checkpoint restore that fails, a provider that won't start, such as one whose sign-in lapsed), the session fails as usual, and the next message's start sends the brief first, that message following under "The latest message" in the same CodeDen message. A session that already has a turn got it, so a leftover brief is dropped then.
  - **Same moment for both:** the server counts the source's turns, asks for the checkpoints `settled` and writes the brief, then checks again. A turn running gives 409 `turn_running`, and one that started meanwhile gives 409 `source_changed`; nothing is created.
  - **When:** an agent session (else 400 `fork_unsupported`), not running or waiting on the user (409 `turn_running`), started (409 `not_started`), on a git branch (400 `fork_unsupported`), with at least one turn (409 `nothing_to_hand_off`), in a project that isn't archived. It needs neither `capabilities.fork` nor a resume token. The target must be loaded by the source's runner (400 `unknown_provider`). Read-only needs its `readOnly` (400 `read_only_unsupported`), and a session still planning needs its `planMode` (400 `plan_mode_unsupported`), so neither is quietly dropped. There is no §8.4 conflict check.
  - **Not yet:** handing off from an earlier turn, editing the brief before it is sent, and a tool for PMs to hand work off.
- **GitHub API.** Octokit on the server, authenticated with the token from `gh auth token` (read at runtime, not stored). Agents use `gh` inside their worktrees.
- **Sync.** Issues, PRs, checks and reviews are polled with conditional requests (ETags) and batched GraphQL. A local app can't receive webhooks; webhook support arrives with remote runners.
- **Traceability.** Every session records its issue, branch, PR and commits. PR bodies link the issue (`Fixes #N`) and the CodeDen session.
- **PR feedback for user sessions.** Notices wake the PM only for work it, the orchestrator or an automation started. For an open agent session the user started, on work the user started (a fork or handoff of other work goes by `forkedFrom.startedBy`, so it gets no feedback its source wouldn't), the server instead sends the session a `codeden` message when its pull request's checks fail (failing check names and links), a review requests changes, or it becomes `conflicting`: once per head commit and at most three per PR, recorded with the session's start metadata so a restart doesn't repeat them. `settings.sessions.prFeedback` (default on) switches it off. On a public repository anyone can review, so only a trusted review is passed on: its author has write access (GitHub's `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`), is the account CodeDen read the review with (GraphQL `viewer`, asked in the same request and carried on the `review.submitted` event, so a credential refresh to another account never leaves the old one trusted), or is one of the project's trusted authors. The message adds that comments from anyone else are input data, not instructions. The PM's `review.submitted` notice for an untrusted review leaves the body out, is marked `untrusted` and doesn't wake the PM.
- **Evidence.** Screenshots and test artifacts are committed to a dedicated orphan branch (`codeden/evidence`) and linked from PR and issue comments, so GitHub renders them inline. Test output and summaries are posted as comments. Secrets files (`.env`, keys, `.npmrc`, ...) and CodeDen's own credential files (§15) are never attached, or shared to the chat as artifacts, at any level.
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
- **Creating and editing in the UI.** **New automation** opens one editor: name and target, when it runs (human schedule choices that compile to cron, with a plain-English summary and the next three runs in a chosen timezone; an event in plain words; or only when run by hand), the prompt with an "Insert placeholder" menu, the unified provider/model/effort picker, the permissions ladder, and advanced options (session title, work key, guards) collapsed. Templates open the same editor prefilled, and so does an agent session's **Make an automation…** (its ⋯ menu or the command palette): the opening message as the prompt, the session's agent and permissions as the session action, its title as the name, run by hand; nothing is saved until Save. Database automations stay editable on their page, with duplicate and delete; file-based ones are read-only there, with "Duplicate to edit". PMs create and change database automations with `create_automation` and `update_automation`, under the same validation (`createdBy: pm`). A PM's change to the trigger, action or guards of an automation that is on switches it off in the same change and puts what changed in the inbox, so a person approves it by switching it on again; renaming leaves it on. Automations for all projects are changed only by the user.
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
4. **Assign.** The server is the orchestrator of an agent swarm: queued items go to free agents within **Agents at once** (`maxConcurrentSessions`), after the open work that is waiting for one (see *Finish before starting* below), and while fewer PRs are open than **PRs open at most** (`maxOpenPrs`). Repairs of the default branch go first, then the issues people filed, then the scout's; within each, by priority, then age. The scout's work never jumps ahead of an issue a person filed. An item likely to touch the files of an open factory PR waits behind items that don't. Each item gets one builder session in its own worktree.
5. **Pipelines.** Bug: **Reproduce** (a failing test or probe, reported with `factory_report_reproduction`; not reproduced stops with a comment) → **Create fix** → **Review fix**. Feature: **Analyze** (does it exist already, does it fit the vision and architecture; a spec and acceptance criteria with `factory_submit_analysis`, posted on the issue) → **Implement** → **Review**. Docs: **Implement docs change**, with no agent review while the change touches only documentation. The builder's report answers with its next step, so one session carries the item.
6. **Review and revise.** A **review by a separate agent session**, on a different provider from the author when one is available. `request_changes` or any failed merge check sends the work back to the builder: the revise loop, up to `maxFixAttempts` rounds. CI on the PR's head is the authority for the full suite, and `request_changes` needs a cause in the PR. A verdict marked `blockers: "environment"` (only the reviewer's local environment couldn't verify the change) is never a revise round: the reviewer gets the CI result and reviews again; a second one fails the item as an infrastructure failure, recovered by the loop, with the next reviewer in a clean worktree on the PR's head.
7. **Evidence.** Every pull request carries its **test results** (a `## Test results` section, or test output attached with `attach_evidence`) and, for UI changes, **screenshots**. Both are merge checks.
8. **Merge.** With every check green the PR is **ready for you** (an inbox item and a PR comment) and you merge it on GitHub. With **auto-merge** on, trusted work joins the **merge queue** and CodeDen squash-merges it in its turn, then watches CI on main; a regression opens an **automatic revert PR**, pauses the loop and raises an inbox item.

**Merge checks** (all must pass): CI green; tests the change needs exist; test results reported; the independent review (skipped for docs-only changes); security and dependency scans clean; screenshots for UI changes; under the size limit (reviewable code only; work that cannot be split is allowed by the PM as a recorded decision); no protected area touched (protected changes always come to you).

**Provider availability and the reviewer** (added 2026-11-13). New builders and reviewers start only on an **available** provider: the runner offers it, its `detect()` says it is installed, not too old to run (a `version_unsupported` issue with a `minVersion`) and signed in (cached; the server asks the runner to detect again every few minutes, without refreshing model lists), its latest rate-limit window isn't `limited` with a reset still ahead, and a factory session on it didn't just fail because of the provider. Tuning chooses the builder's provider and model (`builderProvider`, `builderModel`) and the reviewer's (`reviewerProvider`, `reviewerModel`); `auto` keeps a reviewer on a different provider from the author, among available providers. When the chosen reviewer is unavailable, `reviewerFallback` decides: `builder` (the default) reviews on the builder's provider and model in a fresh session, `any` on any available provider, `wait` waits for it. The reason is recorded in the item's `reviewerNote`. A reviewer session that fails because of its provider (the error kinds `usage_limit` and `auth`, an open refused as `setup` or `auth`, or a session that could not start) restarts on the fallback, never the same provider, and uses neither a revise round nor the reviewer's restarts. With no provider available at all, the review waits: "Waiting: no review provider available until <time>".

**The integration step** (added 2026-11-13). Merging is mechanical, so it is a deterministic step of the server loop, not the PM's job and not a standing agent; an agent is involved only when a conflict needs judgement.
- **Ownership.** The loop owns every PR the factory opened until it merges or closes, whatever its item's stage. Verification looks after its own PRs; the PRs of `failed` and `escalated` items are read every few minutes and kept free of conflicts, also with auto-merge off, so a person never opens a conflicting factory PR. A person merging or closing one finishes its item. The factory never merges an escalated PR; a failed item's PR merges only through a fresh review (below).
- **Stopped work with an open PR** (added 2026-11-14). Each recorded verdict notes the PR head it covers. A `failed` item (`failureKind: checks`; not rejected by its reviewer, not waiting on the PM over its size) whose open, mergeable PR has a newer head than its last verdict, with CI green, goes back to verification by itself: a fresh reviewer in a clean worktree on the PR's head reviews the same PR, with no new build. Approved with every check green, it merges as usual (or is ready for a person); a request for changes gets one more revise round. Once per head, at most three times per item, never while the loop is paused. Verdicts recorded before heads were count a head first seen after the item stopped as newer. Otherwise its note says "Stopped after N revise rounds; needs a re-review (Retry)"; "waiting for a person to merge" is only for escalated work. **Retry** with the PR open (`rereview`, the default then) does the same with fresh revise rounds, with no reproduce or analyze and no second PR; `rebuild` (the default without an open PR) starts over from the first step and closes the old PR with a link once the new one is open. The PM retries with `factory_retry_item` (trusted work on its own; work let in from an untrusted author only at the user's request in that turn, as with `factory_admit_issue`). Retry is offered on the item page and beside stopped items in the factory panel's Recent column. Whether an item can be retried, its default mode and its label come from one shared rule, `stoppedRetry` in the contracts, which the server and the UI both use.
- **Merge queue.** With auto-merge on, a PR whose checks all pass joins the queue: one factory merge at a time, oldest approved first, reverts ahead of everything, at most one merge per tick. Only the head of the queue acts, so CI never runs on every queued PR at once. A head that is behind the default branch is brought up to date through GitHub's update-branch (`expected_head_sha` pinned, no agent); CI is then awaited on the new head, and it merges. Merging main in this way needs no new review. When GitHub refuses to merge or update the head (branch protection, a required check or review, merge settings), the refusal is noted on the item and counted against that head commit; a new head starts the count afresh. GitHub not answering properly (a rate limit, a 5xx or network failure, not connected) is only noted and tried again on the next tick, never counted. The third refusal in a row takes the PR out of the queue: the item is stuck (`failureKind: stuck`) with what GitHub said as its reason, the user and the PM hear once (an inbox item, or a recorded decision in a dark factory), and the next PR in line goes ahead.
- **Conflicts.** A conflicting PR gets no CI, so its agent is asked to rebase it (not a revise round): the builder while its session exists (a message resumes a failed one and brings an archived one and its worktree back; the factory archives it again afterwards), since it has the context and owns the PR's branch. When the builder session is gone, a fresh **integrator** session on the PR's head branch, briefed with the issue, the PR description and the review history, takes the PR over (it also starts CI when the author is gone). If it opens a new PR instead of updating the old one, the item adopts the new PR, whatever its stage, and the old one is closed with a link. After an agent resolved conflicts on an approved PR, CI must pass again and the reviewer re-checks only the resolution (`git range-diff` of the old head against the new one). When that reviewer's session can't take messages any more, a fresh reviewer does the same scoped re-check, told what was approved, and the earlier verdict stands if it approves. Each re-check covers only the head it was asked about, one request at a time. If the PR has a newer head by the time the approval arrives (another resolution, another push), that head is re-checked against the approved one. Nothing merges until the PR's current head has an approved re-check.
- **Rebuild.** A PR still conflicting after three requests to rebase is cheaper to redo than to rescue: the same item goes back to the queue with its reproduction or spec kept and a fresh builder from the latest default branch, and the old PR is closed with a link once the new one is open. Until then the old PR stays the item's: it is owned and listed, and a person merging or closing it finishes the item. A rebuild whose builder dies is resumed by itself (an infrastructure failure). One that ends without a new PR is stuck. One rebuild per item. Closing a replaced PR is a loop step of its own, retried every tick until GitHub accepts, whatever the item's stage by then; until then the panel lists it as superseded.
- **Infrastructure failures don't strand work.** An item that failed for a reason outside its code (its builder or reviewer session died or is gone; CI never started while Actions can run) is recorded as such (`failureKind: infrastructure`), never counts towards the pause, and goes back by itself on the next tick after the cause is gone (the runner offers its provider again): to verification when its PR is open (picked up again, not redone), else to building with a "continue" message, at most three times. What it still owes comes along: a conflict resolution the reviewer hasn't re-checked stays owed (a fresh reviewer takes it over), so the earlier approval never merges an unchecked resolution. Only a recorded verdict clears it, and an approval clears it only for the head it was asked about. CI that never started is kicked again by the verify step: update-branch when behind, otherwise an empty commit from the builder, or from a fresh integrator when the author's session is gone. Either waits for a free agent. Its clock waits until the kick happened. Failures recorded before this are recognised by their reason.
- **Truly stuck.** Only these reach the PM (woken) and the inbox: an item that already used its rebuild (or whose rebuild ended without a new PR), a protected area, and CI that can never run (Actions off, no active workflow). Each is recorded as `failureKind: stuck`. In a dark factory each is a recorded decision flagged for the user, listed in the digest; never a PR silently waiting.

**Finish before starting** (added 2026-11-13). Every open PR a merge leaves behind needs a rebase and maybe a re-review, so the factory finishes open work before it starts more.
- **Slot priority.** When an agent slot is free, it goes to, in order: (1) a reviewer for a PR whose CI passed (a first review, a re-review after a revise round, a re-check of a conflict resolution); (2) a rebase or conflict resolution (a request to the PR's agent, an integrator, a CI kick) or a builder's revise round; (3) a reviewer for a PR whose CI is still running; (4) a builder resumed after a failure outside its code, then a new build from the queue; (5) the scout and its area reviewers. Within a tier, what waited longer goes first; queued builds keep the queue's order. Work in flight is never interrupted: a message to an agent mid-turn waits behind that turn and needs no slot, and only waking an agent between turns takes one, so revise rounds and rebase requests no longer go past the agent limit. The server keeps the slot queue in memory: work refused a slot on one tick is served first on the next, and a waiting claim that doesn't come back stops counting after one tick, so nothing waits on work that moved on.
- **Work-in-progress limit.** `maxOpenPrs` (**PRs open at most**; unset, the default: the agent limit). It counts the open PRs of work the loop is still taking to a merge: being built on, checked, reviewed, revised, rebased, queued or ready for a person to merge. PRs of failed or escalated work, which wait for a person, don't count, so a PR nobody looks at can't stop the factory; a failure outside its code goes back by itself, so its PR counts (unless it waits on its builder's provider, which is signed out, at its usage limit or not installed: then it doesn't count, so a provider being out never stops new work on the others; `FactoryStatus.wip` says which PRs wait on what, and the PM hears once when work has waited on a provider for five minutes), and so does a queued rebuild's PR until its replacement opens. Builds from the queue that haven't opened their PR yet take room under the limit too, since each will, and so does every build a tick starts, so the limit is never overshot. At or above the limit no new build starts from the queue (repairs of the default branch excepted, since every open PR waits on them, and a rebuild, which replaces its PR), the scout starts no round and files no issue (a running round keeps its findings, and a round without area reviewers its review, until the factory is under the limit; time held doesn't count against the round's three hours), and free agents go to reviews, fixes and rebases. The factory panel and the Factory view show "Finishing open work (N of M PRs open)", and "1 PR waits on Codex (not signed in) and doesn't count" while work waits on a provider.
- **Overlap-aware scheduling.** Before a queued item starts, the paths it names (in its title, its issue's body and its acceptance criteria) are compared with the files the factory's open PRs change, as last read from GitHub. An item that clearly overlaps one (the same file, or a directory holding a changed file) goes behind items that don't; it still starts when nothing else is waiting, so overlap only reorders and never deadlocks. Repairs of the default branch keep their place.

**The dark factory** adds a **scout**: one long-lived agent session per project that, when fewer than `minBacklog` items wait and `discoveryIntervalMin` has passed, reviews the app against the vision and files the work worth doing as GitHub issues. It may use **review areas** (UI and UX, performance, security, features, bugs, code quality, test gaps, docs), each with an **area reviewer**: a long-lived reviewer session for that one area, reused round after round so it keeps its context. To keep token use down the server enforces: at most `discoveryPerRound` review areas per round (**Review areas per round** in the UI) and only on free agent slots (all other work comes first), at most one session per area ever, at most `maxIssuesPerRound` issues per round, no round while the queue is full, and no round or filing at the work-in-progress limit. Filed issues enter the pipelines already typed.

**Vision.** Both factory modes require a project vision in `.codeden/VISION.md`, edited in the UI. It covers goals, target users and principles; what is out of scope; the quality bar; and **protected areas** (paths or topics that always need a human: auth, payments, data migrations, infrastructure, licensing). Agents get it in their prompts; the analyzer checks requests against it; the scout finds work with it.

**Unattended in dark factory.** Nobody waits on the user in dark-factory mode. A question from the PM or a factory session (through `ask_user` or the provider's own question tool) is answered at once by the server: decide from the vision, which wins over the current code. An MCP server's form is never answered for the user, since its answers would go to the server as data: it is withdrawn (no data sent) on the same terms as an approval is denied. The agent records each judgement call with `factory_record_decision`, and it reaches the inbox and the digest for review. Protected areas, a missing or self-contradicting vision, and irreversible actions outside the code are flagged at high priority, but the loop never blocks on them. Sessions the user starts still ask as usual. Approvals are never granted on the user's behalf: in a dark factory the PM's and factory sessions' approvals are **denied** at once with the same guidance, and sessions started by an automation, a PM or the factory in other modes wait 30 minutes for the user, then are denied (`decidedBy: policy`), so unattended work never waits forever.

**Limits** (required, enforced by the server, not left to agent judgement):
- agents at once, automatic merges per day (with auto-merge on)
- a token or cost budget per day
- **Pause on repeated failures:** the loop pauses after N failed merge checks or reverts in a row.
- **Protected areas** always escalate to you.
- **No deploys or releases** unless they're explicitly enabled as a separate automation.
- **A kill switch** on the project and globally: one click stops the loop and all its sessions, the scout and its area reviewers included.

**Visibility.** Factory work is ordinary sessions, issues and PRs, so it all stays traceable. The project page shows the **pipelines as a live diagram** (Issue, Identify type, the Bug, Feature and Docs lanes, Merge, and the scout in a dark factory) with each work item on the node of its current step; clicking an item opens the agent session working on it. Every lane, step, the scout, its rounds and review areas, and the less obvious limits explain themselves in plain words: a tooltip on the underlined term or a "?" beside it, opened by hover, keyboard focus or a tap. Around it: spend against budget, agents working, PRs ready for you, the factory's **pull requests** (the merge queue in order, then the other PRs it owns, each with its state: checking, waiting for CI, queued, updating, rebasing, rebuilding, superseded, waiting for you, stuck, merged), merge-check results, recent results, ignored issues with **Let in**, and a daily digest. For watching rather than configuring there is the **Factory view** (`/projects/:id/factory/view`, factory modes only): full screen and outside the app shell. It shows the pipeline as stages (Intake, Identify type, Building, Reviewing, Merge queue, Merged), with every item as a card showing its progress line, time in step, PR state, check count and state, and a **Needs you** lane for exactly the work that waits on a person, by one shared definition (`factoryNeed` in the contracts, which the header count, the pixel scene and the daily digest's "Waiting on you" use too): escalations and PRs a person merges ("Review and merge PR #n"), failures with an open PR ("Retry"), failures from the last day without one ("Retry or dismiss"; **Dismiss** marks the item `rejected` with the reason) and agents' questions and approvals ("Answer"), each card with that button. A failure outside its code that the loop still puts back by itself (`FactoryWorkItem.recovering`) stays in its stage; a failed item without a PR of its own (or a rebuild's original) whose issue is closed on GitHub settles by itself, `merged` when a merged PR that links the issue closed it and `rejected` otherwise, with the reason (`GithubIssue.stateReason` says duplicate, not planned or completed). `FactoryStatus.viewRecent` lists the escalations, open or recent failures and today's merges uncapped (queried apart from the item history limit), so none drop out behind the panel's 30 recent results. Each work item's `ownedPr` names the open PR the factory still owns (its own, or a rebuild's original), so the view doesn't depend on the capped PR list. Above it are one row of figures (`FactoryStatus.stats` adds today's merges, failures and reverts and the 7-day median time to merge) and a header with the loop state, the kill switch, **Check now** and **Run scout now**. Beside it is a quick PM chat. Clicking a card opens a side sheet with its steps, PR, checks and sessions. An optional, decorative **pixel mode** (remembered per browser, not offered on phones) swaps the figures and stages for a small canvas scene of the same items as workers, tickets, crates and machines that open the same side sheet, at about 12 frames a second, paused while hidden and still with reduced motion. It all updates over the same WebSocket as the panel.

**Cleanup.** Finished work gives its space back. Once an item is merged, reverted, rejected or failed, the server archives its builder and reviewer sessions through the normal archive path (§9), which removes their worktrees and keeps the branch, checkpoints and transcript. Work that isn't finished keeps its sessions: escalated items, merges whose main CI is still watched, and an item that failed only on size while its PR is open (the PM may still allow it). A session is never cut off: the item waits while one of them is in a turn. An item's sessions are archived once (`sessionsArchivedAt`), so a session the user unarchives stays; when the loop itself brings a finished item's builder (or integrator) back to rebase its PR, it archives it again once that turn is over. **Retry** hands the earlier attempt's sessions to the same cleanup (`earlierSessionIds`, archived once none of them is busy), unless they were archived already. Its PRs stay owned: the open one it replaces, and any still to be closed, are closed with a link once the new attempt's PR is open. The scout and its area reviewers are never archived this way.

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

Not every item needs the user, so the server tags each one with a category when it raises it (`InboxItem.notify`), and Settings → Notifications chooses which categories toast and notify. Every item lands in the inbox either way.

- **Needs you** (on): approvals and questions, PRs only a person merges (the factory's "ready for you" and escalations, PRs of sessions the factory doesn't run), factory decisions flagged `needsHuman`, start conflicts, budget alerts.
- **Failures** (on): failed runs of sessions the factory doesn't run, a paused factory loop, a regression, a worktree that couldn't be removed.
- **Factory activity** (off): what the factory handles itself: its decisions, the PRs it reviews and merges, its own sessions' failures, stopped items, the daily digest.
- **Automations** (on): automation results and triage decisions.

A failed session raises its `run_failed` item, and that item is its only toast. Updates arriving within a few seconds of each other share one toast ("4 updates from the factory · Open inbox"), and at most three toasts show at once. A toast says what happened in one line (the item's title and the first sentence of its body that adds to it). **Open** goes to the thing itself: a failed run's session, otherwise the item in the inbox (a conflict's card included), scrolled into view and highlighted. Browser and system notifications follow the same rules, one per group: a group's notifications share a tag, and the desktop app, like the browser, replaces the one on screen with the same tag (silently) instead of stacking another, so only the latest answers a click.

Approvals and questions block an agent, so they get stronger cues. When one arrives live, a short chime plays (synthesized in the browser, debounced so a burst plays once, on by default and switchable in Settings) and a sticky toast with **Open** stays until the item is opened or resolved. While any is open, the favicon carries an amber dot, and a background tab's title alternates with "Waiting on you". The first such toast also offers, once, to turn on browser notifications.

### 11.2 Autonomy levels (Permissions)

The UI calls these **Permissions** and shows them as a ladder, **Read-only → Supervised → Auto → Full**, with one plain line each; they are stored as `autonomy` (`read_only`, `supervised`, `auto`, `full`) on sessions, projects, settings and automation actions. Each level maps onto each provider's **native** enforcement:

- **Read-only:** can read and run checks, but never edits files, commits or pushes.
  - Offered only where the provider reports `capabilities.readOnly`; the server refuses `read_only` agent sessions on other providers. UI and orchestration read the capability, never the provider id.
  - **Claude:** the `default` permission mode, with CodeDen's PreToolUse hook denying the edit tools and every shell command outside the read-only allowlist. Agent sessions may also run the project's checks (test, lint, type-check commands without fix, write, snapshot-update or watch flags). The hook decides per call, so the level can change live.
  - **Codex:** the read-only sandbox with `never` approvals and no network: writes fail instead of asking; it applies from the next turn.
  - **OpenCode:** CodeDen's policy answers each permission ask: every edit is refused, and every command outside the same read-only allowlist as Claude's (checks included for agent sessions), with the reason the agent sees. It decides per request, so the level can change live.
  - **Cursor:** the session runs in Cursor's read-only `ask` mode, and CodeDen's policy refuses every edit and every command outside the same allowlist, as for OpenCode.
  - **Gemini CLI:** the session stays in its `default` mode (which asks before every edit and command), and CodeDen's policy refuses every edit and every command outside the same allowlist, as for OpenCode. CodeDen's own MCP tools still run, recognised by the server Gemini CLI names for them.
  - CodeDen's `create_pull_request` is hidden from and refused for read-only sessions.
  - The orchestrator and PMs are read-only by role (`SessionOptions.readOnly`) at every level, without checks.
- **Supervised:** every edit and command asks.
  - **Claude:** the `default` permission mode, with every edit and command routed to an approval.
  - **Codex:** `untrusted` approvals with the workspace-write sandbox.
  - **OpenCode:** every edit and command is routed to an approval.
  - **Cursor:** every edit and command Cursor asks about is routed to an approval.
  - **Gemini CLI:** every edit and command it asks about is routed to an approval.
- **Auto, risky actions ask** (default):
  - Edits and normal commands inside the worktree run freely.
  - Risky actions go to the inbox: writes outside the worktree, force pushes, deleting branches, global installs, network access to unlisted hosts, and secrets access (reading a credentials file or dumping the environment; search patterns, file names used as data and creating an env file inside the worktree are not access).
  - **Claude:** `acceptEdits` plus a `canUseTool` policy classifier.
  - **Codex:** workspace-write sandbox (network off) plus on-request approvals. The sandbox keeps `.git` read-only and blocks the network, so Codex asks to escalate for ordinary work (`git commit`, `pnpm install`). CodeDen runs every such request through the same risk classifier: what the level allows is approved by policy at once (recorded as `decidedBy: policy`, never shown as a card to answer), and only risky actions reach the user. Patches and extra permissions are judged by their paths the same way. An approved escalation runs outside Codex's sandbox, as Claude's commands do.
  - **OpenCode:** no OS sandbox. The session's permission rules make every edit, command, path outside the worktree and web fetch ask, and CodeDen's risk classifier decides each ask: approved by policy at once, or, for risky actions only, shown to the user.
  - **Cursor:** the classifier decides each permission request Cursor sends, as for OpenCode. Known gap: Cursor's own allowlist (`~/.cursor/cli-config.json`, a project's `.cursor/cli.json`) runs what it allows without asking, so CodeDen judges only what Cursor asks about. Cursor has no option to ignore a project's allowlist, so CodeDen guards it instead (see *Agents' own allow-lists* below). CodeDen never passes `--force`.
  - **Gemini CLI:** the same, from its `default` mode. CodeDen starts it with an admin policy (`--admin-policy`, written to `<data dir>/gemini/admin-policy.toml`) whose rules outrank every allow rule Gemini CLI builds from its settings (`tools.allowed`, MCP servers marked `trust` or listed in `mcp.allowed`) and from user and workspace policy files: commands always ask, and edits and MCP tools ask outside plan mode, so CodeDen decides each. The user's own Gemini CLI rules for those calls stay in force: a second admin file (`<data dir>/gemini/user-rules-<hash>.toml`, named by its content, written only when the rules deny something there) repeats them above CodeDen's rules, which sit at priority 0. The copies keep Gemini CLI's own order (tier, then priority, then load order) and come from the user's `~/.gemini/policies` (in `$GEMINI_CLI_HOME` when set), the project's `.gemini/policies`, and the `tools.exclude`, `tools.allowed`, `mcp.excluded`, `mcp.allowed` and trusted MCP servers of the user's and the project's `settings.json`, merged as Gemini CLI merges them. `deny` and `ask_user` stay as they are, and `allow` becomes `ask_user`. So a `git push --force` the user denies stays denied at every level, and an exception carved out of a deny (`git status` allowed above a deny on every command) asks. Current Gemini CLI releases leave the project's policy tier switched off, but CodeDen still repeats it: it ranks below the user's rules, so it can only deny or ask. Rule files are read like the allow-list warning reads them (small regular files only), and a file Gemini CLI would reject is skipped whole. CodeDen's own rules are in a file of their own, so a copy Gemini CLI rejects can't take them with it. Known gaps: other tools those rules allow (web fetches, say) still run without asking, and so do edits and MCP tools they allow while Gemini CLI plans, where its own plan rules decide them. Deny rules from Gemini CLI extensions, system settings and `policyPaths` aren't repeated, so CodeDen's level decides those calls. Gemini CLI ignores `--admin-policy` on a machine that has system policies of its own. CodeDen never selects its `yolo` or `autoEdit` modes.
- **Full:** no approvals inside the worktree.
  - **Claude:** `bypassPermissions`, and the classifier asks only for writes outside the worktree.
  - **Codex:** workspace-write sandbox with the network on, plus on-request approvals that CodeDen's policy approves unless they write outside the worktree. (With `never`, Codex could not commit at all, since the sandbox keeps `.git` read-only.)
  - **OpenCode:** the same asks as under Auto, and CodeDen's policy approves them all except writes outside the worktree.
  - **Cursor:** the same as OpenCode.
  - **Gemini CLI:** the same as OpenCode.
- **The OS temp directory** (`os.tmpdir()`, `%TEMP%`/`%TMP%`, `$TMPDIR`, `/tmp`, and Git Bash's `/tmp` on Windows) counts as inside the worktree for writes and deletes under Auto and Full, so logs and scratch files there don't ask. Only the temp directories themselves qualify: never their root, a filesystem root or the home directory, and a secrets file written there still asks. Supervised is unchanged.
- **The session's own branch** (the branch of its own worktree, `SessionOptions.ownBranch`; never its base branch or `main`/`master`) may be force-pushed **with a lease** without asking, as after a rebase; plain `--force`, refspecs with `+` and remote deletions still ask. `git branch -d` (merged work only) doesn't ask; `-D` does. `create_pull_request` retries a rejected push of the session's own branch with a lease.
- **Claude's own notes** (its plans folder, `plansDirectory` or `~/.claude/plans`, and the project's auto-memory folder) count like the temp directory for Claude sessions under Auto and Full: plan mode and memory writes don't ask. Only the user's own Claude settings can move them, never a folder covering Claude's config folder, the home directory or a filesystem root, and a secrets file there still asks.
- **MCP tools and elicitations (Codex).** Codex asks before running one of the user's MCP tools that isn't marked read-only, through an MCP elicitation marked as a tool approval (`_meta.codex_approval_kind: "mcp_tool_call"`). CodeDen decides it as it decides a Claude MCP tool call: approved by policy under Auto and Full, a card naming the server, the tool and its arguments under Supervised (unless Codex marks it for the user's own answer), declined under Read-only. CodeDen's own MCP server is trusted and never asks. An MCP server's own form becomes a question card built from its schema (`UserQuestionItem.mcpServer`), and its answers go back to the server as the form's content. Number fields carry their format and the card checks them as they are typed ("1,000" reads as 1000); an answer that still doesn't fit its field is rejected (`invalid_answer`) with what the field takes, and the card stays open, so the server never gets a refusal the user didn't give. The card can also be dismissed, which sends the server nothing; a dismissed or declined form says so in the transcript. Like an approval, the form stays with the user: the PM's `answer_question` refuses it. A link a server asks the user to open (URL mode) becomes an approval card showing the link (web links only), which the user opens. Neither is decided by policy.
- **The classifier reads commands like a shell:** quoted text, heredoc bodies and PowerShell here-strings are data, redirects count only outside quotes, and relative paths resolve from where a `cd` (in the same command, or an earlier one Claude reports) moved the shell.
- **CodeDen's own credential files** (`CODEDEN_CREDENTIAL_FILES`: `install-token`, `runner/runner.json` and `remote-access.json` in the data directory, which the server sends as `SessionOptions.codedenHome`, plus the copy CodeDen keeps of a damaged one before resetting it, `<file>.invalid-<timestamp>` next to it, which holds the same secrets) ask at **every** level, Full included, and are refused for read-only sessions and roles. This covers reading, writing or deleting one, copying or searching the folders that hold them, recursive searches from a folder above them that their name filters don't exclude (`grep -r`, `rg -g`, `findstr /s`, Claude's Grep), listings whose names feed another command (`find … | xargs cat`, `$(find …)`, `-exec`), listing them by name (Claude's Glob), and wildcards matching them. `$CODEDEN_HOME` resolves to the data directory, and other variables in a path match like `*`. Only the agent's part of a path is a pattern: the data directory, and the folders above it, compare literally, so glob characters in its own name (`CodeDen [dev]`) never act as wildcards. A search command is read the way the tool reads it, each word given one role in one pass: an option, an option's value, or an operand (short options taken apart, so `-ne.` is `-n -e .` and `-fFILE` is `-f FILE`; every word after `--` an operand). A value that looks like an option (`rg -r-e`, replacement text `-e`) is never read as one, and search patterns are told apart from file operands by role, not text. Each element of a PowerShell path list (`a,b`: unquoted commas, outside POSIX shells) is checked on its own once its argument's role is known: a list given as the search pattern stays data, and a comma inside quotes stays part of the name. The classifier looks for them across the whole command first, so an earlier ordinary risk (which Full allows) can't hide them. Same-named files elsewhere are unaffected. A session approval covers them only as the exact call in the same directory, never through a whole tool (Claude's Read) or a remembered command that now resolves to them. Known gaps: Codex runs reads it considers safe inside its sandbox without asking, so only its escalations are judged, and the classifier reads command words, so a program that opens the file itself, or gets its path from input the command doesn't show (a here-document, a file of names, a variable holding the whole path), isn't seen.
- **Agents' own allow-lists** (`./agent-permissions` in the providers package): Cursor's `.cursor/cli.json` and `cli-config.json` (in `.cursor` or a `cursor` config folder), and Gemini CLI's `settings.json` and `trustedFolders.json` in `.gemini`, its system `settings.json` and `system-defaults.json` in `gemini-cli`, and its policy files in `.gemini/policies` or `gemini-cli/policies`. What they allow runs without the agent asking, so an agent that wrote one (`echo '{"permissions":{"allow":["Shell(*)"]}}' > .cursor/cli.json`) would turn CodeDen's approvals off for itself and, once merged, for every later session in the project. Creating or changing one therefore asks at **every** level, Full included, in every edit and command CodeDen judges (Claude's, OpenCode's, Cursor's and Gemini CLI's calls, and the requests Codex escalates), wherever the file is (worktree, a folder in it, the user's home, the system folder). The `.cursor` and `.gemini` folders themselves count when something is copied or moved into them. Shell writes count too: redirects, `tee`, `cp`, `mv`, `ln`, `dd of=`, `sed -i`, `git checkout`/`restore`/`mv`, PowerShell's `Set-Content`, `Out-File`, `Copy-Item`, `New-Item` and `[IO.File]` calls, and inline interpreter code (`node -e`, `python -c`) that names one. Reading, searching, listing, diffing, staging and deleting them don't ask. Like CodeDen's credentials, they are looked for across the whole command first, so an earlier ordinary risk can't hide them; the verdict is `RiskAssessment.always`. When a Cursor or Gemini CLI session starts in a worktree whose `.cursor/cli.json` has `permissions.allow` rules, whose `.gemini/settings.json` allows tools, or whose `.gemini/policies/*.toml` has `allow` rules, its first turn shows a warning naming them (`NoticeItem.code: agent_allow_list`); a factory session's warning also goes on its item (the note) and into the inbox (`inbox:factory-allow-list:<item>`). Known gaps: Codex writes inside its workspace-write sandbox without asking (its own patches and sandboxed commands, at Auto and Full), so those never reach the classifier, and a Codex session can write one of these files in the worktree; only what it escalates is judged. As for credentials, a program that writes the file itself, or a path built at run time (`> $f`), isn't seen either. The start warning catches the file once it exists, the next time a Cursor or Gemini CLI session starts in that worktree (after a merge, in any worktree of the project).
- **Changing the level on a running session** saves it on the session (`PATCH /api/sessions/:id`, recorded as `session.updated`) and sends it to the live provider session. Claude, OpenCode, Cursor and Gemini CLI apply it from the next tool call (`liveAutonomy`); Codex from the next turn, through per-turn approval and sandbox overrides. Approvals already waiting stay waiting.
- **Plan mode** sits on top of the level, for agent sessions on providers that report `capabilities.planMode` (Claude, Cursor and Gemini CLI):
  - Turned on when a session starts or from the composer (`Session.planMode`, sent like the level). The agent explores and proposes a plan.
  - While planning, file edits and writing commands are refused at every level, Full included, by the read-only command rules (which also refuse writing options such as `sort -o`, and unquoted parentheses and braces); reads and the project's checks run. The agent's own notes stay writable at every level, Read-only included, since Claude writes its plan file there. **Claude:** the `plan` permission mode, plus CodeDen's PreToolUse hook (Claude's plan mode hands edits to `canUseTool`, which Auto and Full would approve). **Cursor:** its `plan` mode, plus CodeDen's policy refusing the edits and writing commands it asks about. **Gemini CLI:** its `plan` mode, whose own policy allows only read-only tools and its plan file; CodeDen's policy refuses any edit or writing command it asks about.
  - The plan ends in a `plan` approval. Approving lets the agent implement at the session's level, and the provider reports leaving plan mode (`session.updated { planMode: false }`). Declining keeps it planning, with the user's note as feedback.
  - Turning plan mode off without approving returns to the level. A resumed session keeps its current plan state.

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
  - pointer actions at page coordinates (click, hover, drag, scroll) and typing at whatever has focus: computer use, step 1, for what the snapshot can't reach (canvases, maps, charts, drag handles, custom sliders, games, hover menus)
  - screenshot
  - console and network logs
- **Coordinates.** Viewport CSS pixels, origin top-left: the pixels of a viewport screenshot (agent screenshots are taken at `scale: "css"`) and the units of `getBoundingClientRect`. They are stateless, the same on either engine, and points outside the current viewport are refused.
- **Screenshots.** They can be posted to the chat with `share_to_chat` or attached as PR evidence.
- **Isolation.** One browser context per session in the runner's Chromium; one in-memory session partition per session for native views (`codeden-browser:<sessionId>`, never the window's own session). Cookies and storage never cross sessions.
- **Dev servers.** CodeDen discovers running dev servers so agents and you can open them in one click.
- **Spike first:** attach Microsoft's Playwright MCP over CDP rather than writing the tools ourselves. If several sessions can't share it cleanly, fall back to about ten tools of our own on playwright-core.
- **The key seam:** agents talk to the browser only through CDP. Native views are reached through a per-session CDP relay in the desktop app (§17), so the runner's agent primitives (aria snapshot, click by ref, screenshots, logs) work unchanged on either engine.

### 12.3 Files and diffs

A file tree for the worktree, a file viewer and editor (CodeMirror 6), turn and session diffs from checkpoints, and a PR view. Line comments drafted on a diff are sent to the agent as one review message, through the same send-or-queue path as the composer; the drafts live in the web app only. The PR view shows every changed file of the PR (up to GitHub's 3,000) with its diff from GitHub, so a PR can be reviewed without its worktree.

### 12.4 Agent configuration

First-class screens for each provider's own files:

- **Memory:**
  - Claude: global `~/.claude/CLAUDE.md`, project `CLAUDE.md` and `CLAUDE.local.md`, `.claude/rules/`, and the auto-memory folder.
  - Codex: `~/.codex/AGENTS.md` and repo `AGENTS.md` files, including nested ones.
- **Skills:** each provider's user and project skill folders, with create, edit and enable controls. The switch writes each provider's own setting: Claude's `skillOverrides` (skill name to `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`, the most specific settings file winning) and Codex's `[[skills.config]]` entries in `~/.codex/config.toml` (`path` or `name`, and `enabled`; the last matching entry wins). It edits the file whose entry already decides the skill, otherwise the user-level file, so it reaches every session, worktrees included. Codex user skills are selected by path, project skills by name (a project skill's path differs in every worktree). Only that key or list is rewritten, and comments are kept, including those after a removed value. A `skillOverrides` that isn't an object, and values Claude doesn't know, are ignored. A switch is refused while a settings file that applies can't be parsed or leads outside its folder through a link, so it never picks another file around it, and a `config.toml` edit that would drop a comment is refused rather than made. Claude's partial states are shown but not set here. The tab offers switches for providers with `agentConfigFeatures[p].skillSwitches`.
- **Subagents:** `.claude/agents/` and `~/.claude/agents/`, plus Codex equivalents where they exist.
- **MCP servers:** `.mcp.json`, Claude user config and `~/.codex/config.toml`. Add, edit, test the connection, and enable per provider.
- **Hooks:** the `hooks` key of Claude's `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`, listed by file with event, matcher, type, command and timeout. Add, edit, disable and delete; only the `hooks` value is rewritten. Claude has no per-hook switch, so disabling moves the hook to a shelf in CodeDen's data folder and enabling writes it back. The tab shows for providers whose native config has hooks (`agentConfigFeatures` in contracts).
- **What's loaded:** for any session, a view of which memory files, skills, MCP servers and hooks are in its context. Skills switched off for the session's working folder are listed dimmed as "off". Hooks are those of the settings files that apply to the session's working folder, with the file whose `disableAllHooks` turns them off.
- **`/` commands:** the composer's `/` menu (§13) lists, per session, the skills What's loaded finds (except those switched off) and the provider's custom command files (Claude's `.claude/commands/` and `~/.claude/commands/`). Once the provider reports a non-empty list of what it runs for the session (`session.updated { commands }`; Claude Code reports its built-in, plugin and custom commands and skills), that list decides which names are offered, and a built-in command wins over a file of the same name. Picking one inserts `/<name> `.

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

- **Ledger.** Every turn records a **usage delta**. It's computed from the provider's own figures: Claude reports cumulative session totals, so CodeDen stores the per-turn difference; OpenCode reports each model call with its tokens and cost, so a turn is their sum. Each delta holds:
  - input, output, cache-read and cache-write tokens
  - reasoning tokens where reported
  - cost in USD as reported by the provider
  - session, project, provider, model, role (orchestrator, PM or agent), `startedBy`, automation id and timestamp
- **Cost sources are labelled honestly.** Each figure is marked `reported` (the provider returned a USD cost) or `estimated` (tokens multiplied by a bundled, user-editable price table per model).
  - **API-key users** see actual spend.
  - **Subscription users** (a claude.ai or ChatGPT login) see an **"API-equivalent cost"**, clearly labelled as such, so they know what the same work would cost on API credits.
  - **OpenCode** model ids such as `anthropic/<model>` and `openai/<model>` are priced from the Claude and Codex tables when OpenCode reports no cost.
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
- **In context.** Cost and tokens appear on each session header and turn footer, a per-project spend card sits on project home, and the dark-factory budget meter (§10.1) reads from the same ledger. Each finished subagent card shows what that run cost (§7.3), priced with the same table and labels; it is a breakdown of work the turns already count, so it never adds to the ledger, totals, budgets or factory limits.
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
  - provider, model and effort pickers, plus the autonomy level and a **Plan** toggle where the provider reports `planMode` (§11.2)
  - queue or steer while a turn runs
  - the voice button
  - **follow-up chips** after a turn completes (§7.5)
- **New session.** Opens a draft in the centre that looks and works like a session, with the same composer (pickers, attachments, `@` and `/` from the project folder and the chosen provider, send keys) and the optional work key behind the header's ⋯. Nothing is created until the first send, which starts the session (`POST /api/sessions`, with the duplicate-work check of §8.4 shown inline); the draft then becomes that session in place. An unsent draft (text, options, work key) is kept in the browser per project.
- **Right panel** (tabs): diff, files, browser, terminal, issue/PR, session details. A bottom terminal drawer is optional.
- **Global:** command palette, keyboard shortcuts, settings, light and dark themes.
- **Transcript search.**
  - **In the palette.** From three characters on, the command palette adds a **Transcripts** group under the session matches, with the five newest. Each hit shows the session, project, role, archived state, a highlighted snippet and the time.
  - **The results page.** **Search all transcripts** opens `/search?q=`, which lists every match, newest first, 50 at a time with **Load more**. It filters by project and role and can leave out archived sessions (`&project=`, `&role=`, `&archived=false`).
  - **Opening a hit.** A hit opens `/sessions/:id?item=`. The transcript scrolls to the item instead of the end, opens its work group if it's a collapsed step, and highlights it briefly. For a match inside a subagent's thread, `item` is the subagent card, and `thread` and `threadItem` open that thread in the right panel, scrolled to the item.
- **Session actions.** The thread header's ⋯ menu offers **Fork session** (§9) when the provider reports `fork`. It is disabled with the reason while a turn runs, and the command palette offers **Fork this session** for the session on screen. The footer of a finished turn in the session's own thread offers **Fork from here** (on hover; always shown on touch screens) when that turn can be forked from: it is the latest turn, or it recorded a fork point. While a turn runs it is disabled and says why. A fork shows where it came from: a "Fork of …" chip in its header, a **Forked from** row in Session details (with the turn its conversation ends at, for a fork from a turn), and a note in its empty transcript.
- **Phones and tablets.** The same layout adapts rather than a separate app (narrow desktop windows with a mouse keep the desktop layout): on phones (< 768 px) and portrait touch tablets (< 1024 px) the sidebar is a slide-out drawer opened from a menu button in every header; touch tablets in landscape (1024–1279 px) keep the icon rail, which expands into the drawer. In both, the right panel opens as an overlay sheet (full screen on phones) instead of squeezing the transcript, and phones use its Terminal tab instead of the bottom drawer. Touch screens get tap targets of at least 40 px and 16 px form fields, and hover-only affordances (row menus, copy buttons) are always shown when the device can't hover. A web app manifest and icons make **Add to Home Screen** open CodeDen full screen; there is no service worker (§15.1).
- **Platform bridge.** Notifications, opening links, folder picking, global shortcuts, clipboard images and badge counts go through one `PlatformBridge` interface in the UI. It has a web implementation and a desktop one (§17), chosen by detecting the desktop app's `window.codedenDesktop` bridge; features are read from `capabilities`, never "am I in Electron?". Browsers can't return real folder paths, so projects are added through a **server-side folder picker**, which also suits remote use; the desktop app (`capabilities.folderPicker`) uses the system folder picker, with the server-side one as a fallback.

## 14. First-run setup and inheriting credentials

The goal is to get from `npx codeden` to your first session in under a minute, without typing a single credential if your machine is already set up.

1. **Start.** `npx codeden` checks the Node version, creates `~/.codeden/`, generates the install token, starts the server and runner, and opens the browser on an already-authenticated URL.
2. **Detect.** One checklist screen with live ticks. All checks run in parallel and nothing is asked when a check passes:
   - **Finding the tools.** Claude Code, Codex and gh are looked for on PATH, then in their installers' own folders (Claude Code: `~/.local/bin`, and the older `~/.claude/local`; Codex: `~/.local/bin` and `$CODEX_HOME/packages/standalone`; Cursor: `~/.local/bin`, and `%LOCALAPPDATA%\cursor-agent` on Windows; Gemini CLI: Homebrew on macOS; gh: Program Files on Windows, Homebrew on macOS). Each copy found is checked before it is used: a shim's package must exist, a link must not dangle, and `--version` must answer within a few seconds (cached per file and modification time). Broken copies are skipped, so a working native install wins over a leftover npm shim earlier on PATH. When only broken copies exist the row says **installed but broken** and lists their paths; when nothing is found it says **not installed**. A re-check (and the runner's provider re-detect) first picks up PATH changes made since CodeDen started: on Windows from the user's and the machine's `Path` in the registry, added to the server's and the runner's PATH so agents and terminals started afterwards see them too.
   - **Claude Code:** `claude --version`, then `claude auth status`. This returns JSON with `loggedIn`, `authMethod` and `loginExpiresAt`. Logged in means ready; the Agent SDK uses the installed binary and its login.
   - **Claude Code support:** when `claude` is installed, a row for the Claude Agent SDK. It installs into `~/.codeden/deps/` when the user continues, with live progress; a failure shows npm's reason and a **Retry**. Sessions that start before it is installed install it themselves, and `codeden doctor --install` does it from a terminal.
   - **Codex:** `codex --version`, then `codex login status`. Logged in also enables **image generation through Codex** as the default engine (§12.5).
   - **OpenCode:** `opencode --version` (2.2 or newer; OpenCode 1 is a different API), then `opencode auth list --standalone` for its connected providers, on a private server rather than the user's background service. OpenCode's own free models work without an account, so no provider is a warning, not a blocker.
   - **Cursor:** `agent --version` (`cursor-agent`, or an `agent` with Cursor's dated version), then `agent acp --help` (a CLI without the ACP server needs `agent update`), then `agent status` for the login (`agent login`). A `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` in the environment counts as signed in.
   - **Gemini CLI:** `gemini --version` (0.68.0 or newer, else `npm install -g @google/gemini-cli@latest`), then the login from Gemini CLI's own settings and which login variables are set (§7.2), since it has no status command. A login it can't confirm (kept in the system keychain, or a key in a `.env` file) is a warning, not a blocker; signed out offers **Sign in**, which runs `gemini`.
   - **GitHub:** `gh auth status`. Logged in means ready, and the token is read at runtime with `gh auth token`, never stored.
   - **git identity:** `git config user.name` and `user.email`.
   - **Browser:** an installed Edge or Chrome.
3. **Fix only what's missing.** Each failed check has one action:
   - The install command for the tool.
   - Or a **Sign in** button that runs the tool's own login (`claude auth login`, `codex login`, `opencode auth login`, `agent login`, `gemini`, `gh auth login`) in an embedded terminal, so the provider's normal browser login flow handles it. It runs the exact copy detection found, by its full path and quoted for the terminal's shell (`& 'C:\Users\x\.local\bin\claude.exe' auth login` in PowerShell), so a broken shim or an outdated PATH in the terminal can't get in the way.
   - A login state that can't be read is a warning with the underlying error (exit code, output) in the row's details.
   - API keys are only an advanced alternative, never the default ask.

   At least one agent provider is required; GitHub is recommended but optional (local-only projects work without it).
4. **Optional extras,** skippable: voice (test the mic, choose read-aloud on or off, optional ElevenLabs key into the keychain) and notifications permission. A **"Use local Whisper for dictation"** card (§11.3) picks the local engine, starts downloading the runtime and the default model with live progress and offers the same five-second test as Settings. It is recommended when the browser has no working speech recognition, never blocks finishing setup, and the download carries on in the background when the user moves on.
5. **First project.** Pick a local folder or clone a GitHub repo. CodeDen detects the package manager and suggests a worktree setup script, then opens the project's **New session** view, so the first session is one message away. Adding a project from the sidebar lands there too, and a project home with no sessions explains what a session is and offers **Start a session**.
6. **Re-check on every launch,** silently. Warnings appear only when something changes, such as an expiring Claude login (`loginExpiresAt`), a logged-out CLI or a version too old for the adapter.

## 15. Security

- **Network.** The server and runner listen on **127.0.0.1 only** by default. A per-install random token is required on every local HTTP, WebSocket and MCP request. Network access for phones and tablets is opt-in (§15.1).
- **Request checks.** `Origin` and `Host` headers are checked, which blocks other websites and DNS rebinding from reaching the local API. While network access is on they also accept the machine's own LAN and VPN addresses on the server port, and nothing else.
- **The UI token.** It's delivered once through the launch URL and then held in an HttpOnly, SameSite=Strict cookie.
- **MCP tokens** are per session and role-scoped, and revoked when the session ends.
- **Agent environments.** Agent processes (every provider), terminals and setup scripts inherit the user's environment minus CodeDen's own `CODEDEN_*` variables (its home, installer, secrets and the like) and `ELECTRON_RUN_AS_NODE`. A variable CodeDen means a session to see is passed explicitly (`SessionOptions.env`). The one variable CodeDen adds for agents is `CI=true`, unless the project turned it off (§4.2). Tokens are never logged or written into transcripts.
- **CodeDen's own credential files** (the install token, the runner lock and the remote access store in the data directory) are never read or written by an agent without the user, at any level; read-only sessions are refused (§11.2, which also lists the known gaps).
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

### 15.2 Remote runners and the network rule (**needs the user's decision**)

Details are in [remote-runners.md](remote-runners.md) §7 and §9.2. Nothing here changes the §3 rule until the user decides.

- **Proposed: exec links only.** The server reaches sandboxed runners through the backend's own authenticated stdio channel (the Docker daemon, Upstash's API over TLS). The runner listens on the sandbox's loopback, and the server opens no new listener, so the rule holds unchanged.
- **Deferred:** a dial-out attach listener for runners the server can't exec into. It would be a separate port, off by default, bound to 127.0.0.1 and exposed through the user's own reverse proxy or tunnel, with per-runner secrets over TLS.
- **Deferred:** an internet-facing UI for a self-hosted server. The user's VPN works today.
- **Sandbox runners are untrusted.** A sandbox runner shares its sandbox with an agent that has a shell, so the server treats what it sends as untrusted input; only the home runner is trusted. An event that names a session is stored only when that session is routed to the runner that sent it (its `sessions.runnerId` is that runner's journal id); anything else is dropped, logged and acknowledged. Terminal output and exits count only for ptys the server opened on that runner, and browser streams only for its sessions. A journal id keys a runner's ack position and its sessions' routing, so it must be the runner's own: a `welcome` reporting an id another runner record carries (deleted ones too) is refused; a runner other than the home runner must report a new id on its first connection (one no session or ack position carries) and keep it afterwards (under a new one its sessions would fall back to the home runner). Details in [remote-runners.md](remote-runners.md) §8.
- **Tokens are the boundary.** Docker Desktop forwards `host.docker.internal` to the host's loopback, so a local container reaches 127.0.0.1 services as a loopback peer (seen in the spike). The install token and the server's own secrets never enter a sandbox. Provider credentials are sent over the link into runner memory only, never into images, snapshots or container config.
- **GitHub credentials in sandboxes:** brokered per server-initiated git operation (option A, built). The server sends the GitHub token with a clone, fetch or push on a runner other than the home runner, and only for an https remote on github.com. The runner hands it to that one git process through its environment, behind an emptied credential-helper list and a helper scoped to `https://github.com`, so a remote an agent rewrote to point elsewhere gets nothing. It is never stored (no helper, no `.git/config`, no remote URL), and never journaled, logged or put in an event. Agents in a sandbox get no token; they use CodeDen's GitHub tools. A token scoped to the repo in the sandbox (B) or git bundles through the server (C) remain possible later.

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
| OpenCode | Third provider | OpenCode through a private `opencode serve` per session (§7.2): setup, models, approvals, questions, subagents, steering, resume and usage |
| Cursor | Fourth provider | Cursor through its CLI's ACP server (`agent acp`) and a generic ACP client (§7.2): setup, models, approvals, plan mode, questions, todos, interrupt and resume, then subagents as child threads and image generation |
| Remote runners | Sandboxed agent sessions | Eight phases ([remote-runners.md](remote-runners.md) §18): several runners with per-session routing; the exec link (`codeden runner-link`); clone workspaces, file access and MCP over the link; the Docker backend; the runner picker and health; the Upstash Box backend; idle pause, cleanup and compute cost; the self-hosting guide |
| Gemini CLI | Fifth provider | Gemini CLI through its ACP server (`gemini --acp`) on the generic ACP client (§7.2): setup without `authenticate`, its model aliases, approvals with its MCP metadata, plan mode through its `exit_plan_mode`, interrupt and resume |
| Later | | More ACP agents, OpenCode's revert, fork and plan agent, more runner backends (Docker Sandboxes, SSH/VPS, a dial-out link), local-only projects in sandboxes, webhooks, GitLab and other forges, remote/mobile access |

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
