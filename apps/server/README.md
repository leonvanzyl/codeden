# @codeden/server

The long-lived CodeDen server (design §4.1): Hono HTTP API and UI WebSocket, the SQLite event log and projections, the runner client, and the internal MCP endpoint.

## Internal MCP endpoint (§4.4, §8.3)

- `POST /mcp`: Streamable HTTP, stateless (one MCP server and transport per request), responses stream as SSE. Agents reach it through the runner's local proxy (`http://127.0.0.1:<runnerPort>/mcp`).
- **Auth:** a per-session bearer token (`cdm_...`), minted when a session starts or resumes, stored only as a SHA-256 hash (`mcp_tokens`), revoked when the session stops, completes or fails. The install token is not accepted here, and MCP tokens are not accepted by `/api`.
- **Registry:** one file per tool in `src/mcp/tools/`, declared with `defineTool({ name, description, roles, scope, input, alwaysLoad?, handler })`. Tools outside the caller's role are neither listed nor callable. Always-loaded tools carry `_meta["anthropic/alwaysLoad"] = true`.
- **Injection:** the launcher passes CodeDen's server (`codeden`) as a trusted HTTP MCP server, so Claude allows `mcp__codeden` tools and Codex runs them with `default_tools_approval_mode = "approve"`. Agent sessions also get a short CodeDen system-prompt section (`src/mcp/prompt.ts`).

| Tool | Roles | What it does |
|---|---|---|
| `report_progress` | agent | Sets `session.progress` |
| `ask_user` | agent, pm | Question in the transcript and inbox (see below) |
| `share_to_chat` | all | File or base64 image -> artifact under `<home>/artifacts`, shown as a `notice` item (`code: "shared_artifact"`) |
| `suggest_followups` | agent | 2-4 prompts -> `followups` item on the current turn |
| `finish` | agent | Structured `session.result` |
| `browser_navigate` | agent | Open a URL in the session browser (opens it on first use) |
| `browser_snapshot` | agent | Aria snapshot (YAML) with element refs |
| `browser_click` / `browser_type` / `browser_press` | agent | Act on a ref / press a key or chord |
| `browser_screenshot` | agent | PNG -> `screenshot` artifact, returned as MCP image content; `share: true` posts it to the chat |
| `browser_logs` | agent | Console and network entries (`since` paging) |
| `browser_wait` | agent | Selector, text or network idle |
| `browser_evaluate` | agent | Guarded JS evaluation (5 s timeout, result size cap, can be disabled in the runner) |
| `browser_open_dev_server` | agent | Open `localhost:<port>`; without a port, the only running dev server or a list |
| `generate_image` | all | Images from the Settings engine into the worktree (see below); hidden when no engine is available |
| `create_pull_request` | agent | Commit (optional), push the session branch through the runner, open or update its PR (see GitHub below) |
| `attach_evidence` | agent | Files/artifacts to the `codeden/evidence` branch + one comment embedding them, with summary and test output |
| `comment_on_issue` | agent, pm | Comment on an issue or PR (defaults to the session's issue, then PR) |
| `get_pr_status` | agent, pm | Live state, checks, reviews, mergeability (defaults to the session's PR) |

Browser tools always act on the caller's own session (from its token); no tool takes a session id. A handler can return `new ToolOutput(text, images)` to add MCP `image` content.

### How `ask_user` works with every provider

The question becomes a `user_question` item (`deferred: true`) in the current turn, which the projection mirrors into the inbox. The tool call waits up to 4 minutes (`askUserWaitMs`): an answer within that time is the tool's result. Otherwise it returns `pending`, the agent is told to finish what it can and end its turn, and the deferred question stays open after the turn ends. When the user answers later, the answer is sent to the session as a new user message (queued if a turn is running). This avoids depending on each provider's MCP tool timeout and on long-held HTTP requests.

## Orchestration (§8)

`OrchestrationService` (`src/services/orchestration/`) owns the role sessions, digests, notices and conflicts. Shapes: `@codeden/contracts` `orchestration.ts`, `orchestration-api.ts`.

- **Role sessions.** One orchestrator (cwd `<home>/orchestrator/`) and one PM per project (cwd: the project root), created lazily and reused (resumed through the provider resume token). Provider/model/effort from `settings.providers.orchestrator|pm`. Both run with `SessionOptions.readOnly`: Claude gets no edit tools and a deny policy for writing commands, Codex a `read-only` sandbox. System prompts: `prompts.ts`.
- **Status digest.** Every message to a role session (user, wake, `message_pm`, `ask_pm`, queued) gets a fresh `<codeden_status>` block and any undelivered notices (in a `<codeden_updates>` block) prepended at send time (`SessionService.setInputDecorator`).
- **Notices.** Session/inbox/automation events become typed `Notice` records (`notice.created`, table `notices`). Work started by a PM, the orchestrator or an automation wakes the PM after a 5 s debounce (30 s max wait), at most 6 wakes per 10 minutes per target (`WakeScheduler`). A busy target is retried with backoff (5 s doubling to at most 2 min, 20 attempts); then the wake is dropped and its notices ride along with the target's next message or the next notice. Delivered notices show as a `notice` item with `code: "orchestration_notices"` at the start of the wake turn. GitHub sync events (`pr.opened`, `pr.checks_failed`, `pr.checks_passed`, `pr.merged`, `issue.opened`, `review.submitted`) become notices too (`github-notices.ts`): a session-owned PR wakes the PM like its session does, other PRs wake it for openings and reviews only, new issues always wake it. Other services call `orchestration.notify(...)`. The PM issue tools reach GitHub through `GithubPort`, implemented over `GithubService` by `GithubServicePort`.
- **PM <-> orchestrator.** `ask_pm` waits (default 3 min) for the final message of the PM turn that handled the question; later answers arrive as a message. `message_orchestrator` with `informational: true` never wakes the orchestrator.
- **Conflicts.** A user start that matches running work is persisted (`conflict.created`, table `conflicts`, inbox item kind `conflict`); `POST /api/sessions` answers 409 with `conflictId`.
- **Ports.** `GithubPort` is implemented by `GithubServicePort` and `AutomationPort` by `AutomationService` (see Automations below); `createServices({ orchestration: { github, automation } })` can override either, and the stubs in `ports.ts` remain for builds without them.

| Route | Body / response |
|---|---|
| `GET\|POST /api/orchestration/orchestrator` | -> `RoleSessionResponse` (POST creates it) |
| `POST /api/orchestration/orchestrator/messages` | `RoleMessageRequest` -> `RoleMessageResponse` |
| `GET\|POST /api/orchestration/projects/:id/pm`, `POST .../pm/messages` | same, for the project's PM |
| `GET /api/orchestration/projects/:id/status`, `GET /api/orchestration/overview` | -> `ProjectStatus`, `Overview` |
| `GET /api/orchestration/roles`, `GET /api/orchestration/notices?projectId=&target=&limit=` | -> `RoleSessionsRef`, `Notice[]` |
| `GET /api/conflicts?status=&projectId=`, `GET /api/conflicts/:id` | -> `ConflictRecord[]`, `ConflictRecord` |
| `POST /api/conflicts/:id/resolve` | `ConflictDecision` -> `ResolveConflictResponse` |
| `PATCH /api/sessions/:id` | `UpdateSessionRequest` (model, effort, autonomy, title) -> `Session`; model/effort apply on the next turn, autonomy is sent to the runner at once and applies from the next tool call (`liveAutonomy`) or the next turn (`session.configure`) |

Tools: orchestrator `get_overview`, `list_projects`, `create_project`, `update_project`, `message_pm`, `ask_pm`, `list_inbox`; PM `get_project_status`, `list_sessions`, `start_session`, `message_session`, `stop_session`, `list_scheduled_runs`, `skip_next_run`, `pause_automation`, `resume_automation`, `cancel_queued_run`, `message_orchestrator`, `read_project_notes`, `update_project_notes` (`.codeden/notes.md`), `list_issues`, `get_issue`, `triage_issue`, `create_issue`, `list_automations`, `run_automation`, `report_triage`, plus `ask_user` and `get_pr_status` (shared with agents). Awareness and core tools are always loaded.

## Automations (§10)

`AutomationService` (`src/services/automations/`) owns automation definitions, the cron scheduler, event triggers, guards, runs and issue triage, and implements the PM's `AutomationPort`. Shapes: `@codeden/contracts` `entities/automation.ts` and `automations-api.ts`.

- **Definitions** (all off by default). Built-in templates in `templates/automations/*.md` (copied to `dist/templates/` in the CLI bundle): security audit, refactor sweep, dependency updates, UI review, test coverage gaps, issue triage, stale PR follow-up. Markdown with YAML frontmatter (`AutomationFileFrontmatter`: `name`, `trigger`, `action` = `start_session` | `message_pm` | `triage`, `workKey`, `provider`, `model`, `effort`, `autonomy`, `guards`, triage `policy`, `starter`, `requiresGithub`); the body is the prompt, message or triage guidance. Sources mirrored into the `automations` table (`automation.saved` / `automation.deleted`): global files `<home>/automations/*.md` (id `global:<file>`, all projects, also listed as templates), project files `<repo>/.codeden/automations/*.md` (id `project:<projectId>:<file>`) and database automations (`POST /api/automations`). Folders are watched (plus a 60 s rescan); edits keep the enabled switch, and file automations are read-only through the API apart from enable/disable. A new project gets the starter set (`starter: true` templates that fit it) as disabled database automations (`starter:<projectId>:<template>`).
- **Manual mode.** In a project whose autonomy mode is `manual`, cron and event automations don't fire on their own (no schedule, no next run); manual runs (UI, `run_automation`) still work.
- **Enabled** = `settings.automations.enabled` and the project switch (`automation_projects`) and the automation's own switch (all-projects automations can be overridden per project); triage needs a GitHub project.
- **Placeholders.** Prompts, messages, titles and work keys take `{{project.name}}`, `{{date}}`, `{{time}}`, `{{issue.number|title|url|author|labels|body}}`, `{{pr.number|title|url|branch|base|failedChecks|reviewers}}`, `{{comment.author|body|url}}` (`issue.commented`), `{{session.id|purpose|workKey|summary|outcome}}`. The work key defaults to `automation:<template or name slug>` (`automation:security-audit`, `triage:{{issue.number}}`).
- **Scheduler.** croner computes occurrences in the trigger's timezone, else the project's, else the machine's. The next run per (automation, project) is persisted in `automation_schedules` (operational state, not event-sourced); changes to what the UI shows (next run, skipped occurrence, paused, per-project override, the project switch) append an unprojected `automation.updated` hint so live views refetch. An occurrence more than 2 minutes late (downtime, sleep) is missed: it runs once as `catch_up` when `guards.catchUpMissed`, else it is dropped. One timer, re-armed at most every 60 s.
- **Event triggers.** `issue.opened`, `issue.labeled`, `issue.commented`, `pr.opened`, `pr.review_requested`, `pr.merged`, `pr.checks_failed` (GitHub sync events; `issue.commented` matches labels against the issue's labels and authors against the comment's author, and comments CodeDen posted itself never trigger) and `session.finished`, `session.failed`, `session.needs_input` (from notices), with `filter.labels|branches|authors`. An automation never triggers on a session it started itself.
- **Guards, in order.** Quiet hours and `maxPerDay` (local day; skipped for manual runs) -> the §8.4 work-key conflict check with the overlap policy (`skip-if-running` records a skipped run, `queue` queues the session behind the existing work, `run-anyway` forces with the reason recorded; manual runs return `conflict` unless the caller passes a decision) -> `maxConcurrent` queued/running runs per project (not for queueing or manual runs).
- **Runs.** Every outcome except a manual `conflict` is an `automation_run` row (`automation_run.updated`): `queued`, `running`, `completed`, `failed`, `skipped` (+ `skipReason`), `cancelled`. Session runs link both ways (`run.sessionId`, `session.automationRunId`) and follow the session (idle after a completed turn -> `completed`, interrupted/stopped -> `cancelled`, failed -> `failed`); `message_pm` and triage runs complete once handed to the PM. Skipped runs create an `automation.skipped` notice that wakes the PM.
- **PM tools** (`AutomationPort`): `list_scheduled_runs`, `skip_next_run` (the next occurrence becomes a `skipped_by_pm` run), `pause_automation` / `resume_automation` (per project; no cron or event runs while paused), `cancel_queued_run` (also stops the queued session), `list_automations`, `run_automation` (with `conflict` decisions like `start_session`).
- **Issue triage.** On `issue.opened` with the project's triage automation enabled, the PM gets the issue and the policy (`TriagePolicy`: labels per decision, comment, close rejected, `autoStart`), classifies it with `get_issue` / `list_issues` / `triage_issue` and calls `report_triage`. The triage run (`issueNumber` set) stays `running` until that report arrives (`Triaged as <decision>`), and fails if none arrives within 30 minutes (checked before the next triage run). `ready` issues start a session (`workKey: issue:<n>`) when `autoStart` is on and the project is not in manual mode; otherwise an inbox item of kind `triage` (`triage:<projectId>:<n>`, "Should I take this on?") waits for accept or decline.
- **Intake ownership.** In `software_factory` and `dark_factory` the factory loop owns issue intake (see below): event automations on `issue.opened` / `issue.labeled` whose action is `triage` or `start_session` are not run there but recorded as `skipped` runs with `skipReason: "factory_intake"` (`factoryOwnsIntake` in `event-triggers.ts`), so an issue is never taken on twice. `message_pm` automations still fire, manual runs are unaffected, and the rule holds while a kill switch has the loop stopped (a kill switch never hands work back to automations). In `manual` and `assisted` automations own intake and the factory loop is idle.

| Route | Body / response |
|---|---|
| `GET /api/automations?projectId=` | -> `AutomationListResponse` (automations with per-project `states`, `lastRun`, file `errors`) |
| `POST /api/automations` | `CreateAutomationRequest` (from `templateId` or from scratch; disabled unless `enabled`) -> `AutomationListItem` (201) |
| `GET\|PATCH\|DELETE /api/automations/:id` | -> `AutomationListItem`; `UpdateAutomationRequest`; `{ ok }` (database automations only, else 409 `automation_read_only`) |
| `POST /api/automations/:id/enable\|disable` | `SetAutomationEnabledRequest` (`projectId` = per-project override for all-projects automations) -> `AutomationListItem` |
| `POST /api/automations/:id/run` | `RunAutomationRequest` (`projectId`, `conflict?`, `context?`) -> `RunAutomationResponse` |
| `POST /api/automations/:id/pause\|resume` | `AutomationProjectRequest` -> `AutomationListItem` |
| `POST /api/automations/:id/skip-next` | `AutomationProjectRequest` -> `{ skipped: ScheduledRun \| null }` |
| `POST /api/automations/:id/clear-override` | `AutomationProjectRequest` -> `AutomationListItem` (drops the project's override of an all-projects automation; 409 `no_override` otherwise) |
| `POST /api/automations/:id/unskip-next` | `AutomationProjectRequest` -> `UnskipNextResponse` (`{ next: ScheduledRun \| null }`; undoes a skip, null when nothing was skipped) |
| `GET /api/automations/runs?projectId=&automationId=&status=&limit=`, `GET .../runs/:runId` | -> `AutomationRun[]`, `AutomationRun` |
| `POST /api/automations/runs/:runId/cancel` | -> `AutomationRun` (queued runs only, else 409 `not_queued`) |
| `GET /api/automations/upcoming?projectId=&limit=` | -> `ScheduledRun[]` (the Now / Next strip; a skipped occurrence is followed by the next one) |
| `GET /api/automations/templates` | -> `AutomationTemplate[]` |
| `POST /api/automations/reload` | -> `AutomationListResponse` (re-read automation files now) |
| `POST /api/automations/triage/:itemId/accept\|decline` | `TriageDecisionRequest` -> `TriageDecisionResponse` |
| `POST /api/projects/:id/automations/starter` | `StarterSetRequest` (`enable`) -> `StarterSetResponse` |
| `GET\|PATCH /api/projects/:id/automations/settings` | -> `AutomationProjectSettings`; `UpdateAutomationProjectSettingsRequest` |

## Session browser (§12.2)

The runner owns one Chromium with a context per session (`apps/runner/src/browser`). The server exposes it to the panel and to the agent tools above; shapes are in `@codeden/contracts` (`browser-api.ts`).

| Route | Body / response |
|---|---|
| `POST /api/sessions/:id/browser/open` | `BrowserOpenRequest` -> `BrowserOpenResponse` |
| `POST /api/sessions/:id/browser/close` | -> `{ ok }` |
| `GET /api/sessions/:id/browser/tabs` | -> `BrowserTabsResponse` (`open: false` when the session has no browser) |
| `POST /api/sessions/:id/browser/tabs` | `BrowserNewTabRequest` -> `BrowserTabResponse` |
| `DELETE /api/sessions/:id/browser/tabs/:tabId`, `POST .../tabs/:tabId/activate` | -> `{ ok }` |
| `POST /api/sessions/:id/browser/navigate` | `BrowserNavigateRequest` -> `BrowserNavigateResponse` (opens the browser if needed) |
| `POST /api/sessions/:id/browser/history` | `BrowserHistoryRequest` -> `{ url }` |
| `POST /api/sessions/:id/browser/viewport` | `BrowserViewportRequest` -> `{ ok }` |
| `POST /api/sessions/:id/browser/dev-server` | `BrowserDevServerRequest` -> `BrowserTabResponse` |
| `GET /api/browser/dev-servers?probe=3000,5173` | -> `DevServersResponse` |

Commands on a session without an open browser fail with `409 browser_not_open`.

**`/ws/browser?sessionId=...`** (`BrowserWsQuery`; optional `open=1`, `quality`, `maxWidth`, `maxHeight`, `maxFps`): one socket is one viewer. The server sends `state` (viewer id, open, watching, tabs) on connect and whenever the browser opens or closes, then `frame` (base64 JPEG + metadata) and `tabs` messages (`BrowserServerMessage`). The client sends `input` (mouse/keyboard/text in displayed-frame coordinates), `watch` (optionally with new screencast settings), `unwatch` and `open` (`BrowserClientMessage`). Each socket registers as a screencast viewer in the runner, so the screencast runs only while someone watches; a viewer that connects before the browser exists starts watching as soon as the agent opens it. Frames are skipped for sockets with more than 4 MB unsent.

## Image generation (§12.5)

`ImageService` (`src/services/images/`) wraps the engines from `@codeden/providers` (`ImageEngineRegistry`: Codex, Gemini, OpenAI Images). Gemini and OpenAI keys are read from the keychain (`gemini.apiKey`, `openai.apiKey`) on every call.

- **Engine:** `settings.imageGeneration.engine` (`auto` = Codex when logged in, then the first engine with a key; `none` hides the tool), overridable per project in `settings.imageGeneration.projects[projectId]` (`engine`, `defaultSize`, `quality`, `dailyCap`). Remove an override with `PATCH /api/settings { imageGeneration: { projects: { <id>: null } } }`.
- **Visibility:** availability is detected at startup and cached for 5 minutes (re-checked after settings or secrets change). `generate_image` is listed only while an engine is available.
- **Output:** agents write into their worktree (`outputPath`, default `generated-images/`), refused outside it, in `.git`, or through a symlink that escapes; PMs and the orchestrator write to `<home>/generated/<sessionId>/`. Every image is also an `image` artifact and, unless `share: false`, a `shared_artifact` notice in the chat.
- **Daily caps:** `dailyCap` (all projects) and the project's `dailyCap`, counted per local day in `<home>/image-usage.json`. Images are reserved before the engine runs and released if it fails.

| Route | Body / response |
|---|---|
| `GET /api/images/engines?projectId=` | -> `ImageEnginesResponse` (engines, active engine, today's usage, effective cap) |
| `POST /api/images/test` | `ImageTestRequest` -> `ImageTestResponse` (generates one small image into an artifact unless `generate: false`) |

## Agent configuration (§12.4)

`AgentConfigService` (`src/services/agent-config/`) reads and edits each provider's native files in place. Shapes: `@codeden/contracts` `agent-config.ts`.

- **Discovery.** Claude: `~/.claude/CLAUDE.md`, `~/.claude/rules/**.md`, `~/.claude/skills/<name>/SKILL.md`, `~/.claude/agents/**.md`; per project `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, nested `CLAUDE.md` (`onDemand`), `.claude/rules`, `.claude/skills`, `.claude/agents`, and the auto-memory folder. Codex: `~/.codex/AGENTS.md` (and `AGENTS.override.md`), `~/.codex/skills`, `~/.agents/skills`, `~/.codex/agents/*.toml`; per project `AGENTS.md` files (nested too), `.agents/skills`, `.codex/agents`. Nested scans skip dot folders and build output.
- **Auto memory.** `~/.claude/projects/<slug>/memory/` where the slug is the main repo root with every non-alphanumeric character replaced by `-` (`C:\Projects\codeden` -> `C--Projects-codeden`, checked against real folders on Windows); all worktrees share it. `autoMemoryDirectory` in `~/.claude/settings.json` wins when set.
- **Safety.** Files are addressed by `AgentConfigLocator` (`root`: `home` | `project` | `auto_memory`, plus `path`) and must match a known agent-config location (anything else, `.git`, credentials or `..` is a 403). Writes are atomic; every overwrite or delete copies the old file (or skill folder) to `<home>/backups/agent-config/` first; `expectedSha256` gives optimistic concurrency.
- **MCP servers.** Claude `user` (`~/.claude.json` `mcpServers`), `local` (`~/.claude.json` `projects["C:/path"].mcpServers`, forward slashes on Windows) and `project` (`.mcp.json`); Codex `user` (`~/.codex/config.toml` `[mcp_servers.<name>]`). JSON files are rewritten with their indentation. `config.toml` edits replace only the server's own `[mcp_servers.<name>]` blocks (verified by re-parsing; the TOML library's structural `patch()` is the fallback for inline or dotted definitions), so comments and other settings stay byte for byte. Unknown native fields are kept (`spec.extra`).
- **What's loaded.** Computed from each provider's rules from the session's working directory: Claude walks every ancestor for `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules`, adds `MEMORY.md`, and project skills/subagents up to the repo root; Codex takes `AGENTS.override.md` or `AGENTS.md` in `~/.codex` and in each folder from the repo root down. MCP servers include CodeDen's own.

| Route | Body / response |
|---|---|
| `GET /api/agent-config/files?projectId=&provider=&kind=` | -> `AgentConfigListResponse` |
| `GET /api/agent-config/file?root=&projectId=&path=` | -> `AgentConfigFileContent` (missing files read as empty) |
| `PUT /api/agent-config/file` | `AgentConfigWriteRequest` -> `AgentConfigWriteResponse` (create or overwrite) |
| `POST /api/agent-config/file` | `AgentConfigWriteRequest` -> `AgentConfigWriteResponse` (create only, 409 `file_exists`) |
| `DELETE /api/agent-config/file?root=&projectId=&path=[&folder=1]` | -> `AgentConfigDeleteResponse` |
| `POST /api/agent-config/diff` | `AgentConfigDiffRequest` -> `AgentConfigDiff` |
| `GET /api/agent-config/mcp?projectId=` | -> `McpServerListResponse` |
| `PUT /api/agent-config/mcp` | `McpServerUpsertRequest` -> `McpServerWriteResponse` |
| `DELETE /api/agent-config/mcp?provider=&scope=&projectId=&name=` | -> `McpServerWriteResponse` |
| `POST /api/agent-config/mcp/diff` | `McpServerDiffRequest` -> `AgentConfigDiff` (no `spec` = removal) |
| `GET /api/sessions/:id/agent-config/loaded` | -> `LoadedAgentConfig` |

## Cloud voice (§11.3)

Opt-in proxies next to the browser's speech APIs (which stay the default). Keys come from the keychain (`elevenlabs.apiKey`, `openai.apiKey`) and never reach the browser; a missing key is `409 missing_api_key`, a provider error is `502` with the provider's message. Shapes: `@codeden/contracts` `voice-api.ts`.

| Route | Body / response |
|---|---|
| `GET /api/voice/voices` | -> `VoiceListResponse` (ElevenLabs `GET /v2/voices`) |
| `POST /api/tts` | `TtsRequest` -> streamed `audio/mpeg` (ElevenLabs `POST /v1/text-to-speech/{voice}/stream`; voice from the request, then `settings.voice.readAloud.voice`, then a stock voice; model `eleven_flash_v2_5`) |
| `POST /api/stt?engine=&language=` | raw audio body (`audio/webm`, `audio/ogg`, ...) or multipart `file`, up to 25 MB -> `SttResponse`. ElevenLabs Scribe (`scribe_v2`) or OpenAI (`gpt-4o-mini-transcribe`); default from `settings.voice.dictation.engine` |

## GitHub (§9)

`GithubService` (`src/services/github/`) owns everything GitHub. Shapes: `@codeden/contracts` `github.ts`.

- **Auth.** `gh auth token` is read at runtime and cached in memory only; a 401 asks `gh` again once (picks up a re-login). Fallback: a token in the keychain (`github.token`). Without either, reads return `connection.connected: false` with a hint and GitHub operations fail with `409 github_not_connected`. The token is never logged, stored or returned.
- **Sync.** Per GitHub project: the issues listing (`state=all`, `since` cursor) with `If-None-Match` (a 304 is free), then one batched GraphQL query (20 PRs per request) for PRs that changed, have pending checks or unknown mergeability, belong to a session, are unlinked but open on a session's branch, or every 4th poll. A session created on (or moved to) the head branch of an open, unlinked PR schedules the project's next poll right away, so the link follows within one scheduler tick (5 s). Interval: 15 s while a session's PR is open, 60 s otherwise; exponential backoff on errors, rate limits wait for the reset, "not connected" retries after 5 min. `CODEDEN_GITHUB_SYNC=0` or `startServer({ github: { sync: false } })` turns polling off.
- **Events and projections.** The first import is one silent `github.synced`, plus a `pr.updated` (`changes: ["sessionId"]`) for each imported PR that already belongs to a session, so its `session.pr` and review item follow. Afterwards: `issue.opened`, `issue.labeled` (`added`), `issue.commented` (the comment count went up; carries the new comments, each with `fromCodeden`), `issue.updated` (`changes`), `pr.opened`, `pr.updated`, `pr.review_requested` (`reviewers` newly requested, logins or `org/team`), `pr.checks_passed`, `pr.checks_failed`, `pr.merged`, `pr.closed`, `review.submitted`. Each carries the full row and projects into `github_issues` / `github_prs` (checks summary, review decision, mergeable, linked issues, commits, linked session). PR events carry the linked session as `sessionId`. ETags and cursors live in `github_sync_state` (not event-sourced).
- **Session linkage.** A PR belongs to the session that opened it or whose branch is its head. Every `pr.*` event updates `session.pr`; `pr.merged` stops an idle session's provider, marks it `completed` and comments "Resolved by #N" on the linked issues. When a session-owned PR is open, out of draft and its checks passed (or it has none), a `pr_review` inbox item (`inbox:pr_review:<projectId>:<n>`) asks the user to review it; merging or closing the PR resolves it (`review-inbox.ts`).
- **Pull requests.** `create_pull_request` refuses uncommitted changes unless `commitMessage` is given, pushes with the runner's `git.push`, then creates the PR (or updates the open one for the branch). The body gets `Fixes #<issue>` and a footer naming the session (`<!-- codeden:session=<id> -->`).
- **CodeDen's comments** carry a hidden `<!-- codeden -->` marker (they are posted with the user's token), stripped again when comments are shown to agents or the UI.
- **Evidence.** Files are committed with the Git Data API (blobs, tree on the branch's tree, commit, ref) to the orphan branch `codeden/evidence` under `<pr-N|issue-N>/<sessionId>/`, so no checkout is touched. Comments link `https://github.com/<o>/<r>/blob/<commit>/<path>?raw=true`: GitHub keeps that URL as the `<img src>` and serves it to signed-in readers, so images render in private repositories too (`raw.githubusercontent.com` links would not).
- **Local-only projects:** list routes return empty lists with `connection.message`; everything else is `409 not_a_github_project`. No GitHub request is made.
- **Re-detection** (`src/services/projects/redetector.ts`, `reconcile.ts`). A project's kind is detected again on server start (every project, one at a time), when an `agent.turn.completed|failed|interrupted` lands for a session in a local project, and on `POST /api/projects/:id/refresh`. `ProjectService.refresh` runs `detectProject` and `reconcileProject` and appends `project.updated` only when something changed: local + GitHub `origin` -> `kind: "github"` (then `GithubSync.soon(id, { now: true })`); no checkout -> checkout records `defaultBranch`; another repository on `origin` -> new coordinates; a GitHub project without a GitHub `origin` keeps its coordinates and gets `remoteWarning` (never downgraded). `POST /api/projects/:id/disconnect-github` is the user's way out (`409 github_remote_present` while `origin` is on GitHub, `409 factory_mode` in the software or dark factory). When a `project.updated` points a project at another repository (or makes it a GitHub project), the projector drops its `github_issues`, `github_prs` and `github_sync_state` rows in the same transaction, so the next sync re-imports silently. Remote URLs are stored with credentials removed.

| Route | Body / response |
|---|---|
| `POST /api/projects/:id/refresh` | -> `RefreshProjectResponse` (`outcome`, `changed`, `message`, `detected`) |
| `POST /api/projects/:id/disconnect-github` | -> `DisconnectGithubResponse` |
| `GET /api/github/connection` | -> `GithubConnection` |
| `GET /api/projects/:id/github/issues?state=&limit=` | -> `GithubIssuesResponse` (projection + connection + sync status) |
| `GET /api/projects/:id/github/prs?state=&limit=` | -> `GithubPrsResponse` |
| `POST /api/projects/:id/github/sync` | -> `GithubSyncStatus` (sync now) |
| `POST /api/projects/:id/github/issues` | `CreateGithubIssueRequest` -> `GithubIssue` (201) |
| `GET /api/projects/:id/github/issues/:number` | -> `GithubIssueDetails` (fresh, with recent comments) |
| `POST /api/projects/:id/github/issues/:number/comments` | `GithubCommentRequest` -> `GithubCommentResponse` (201) |
| `POST /api/projects/:id/github/issues/:number/labels` | `GithubLabelRequest` -> `GithubIssue` |
| `POST /api/projects/:id/github/issues/:number/triage` | `TriageIssueRequest` -> `TriageIssueResult` |
| `GET /api/prs/:id` (`<projectId>:<number>`) | -> `GithubPrDetails` (live status, body, files) |
| `POST /api/prs/:id/merge` | `MergePrRequest` (squash by default) -> `MergePrResponse` |
| `GET /api/sessions/:id/github` | -> `SessionGithubResponse` |

## Update check (§16)

`GET /api/updates?refresh=1` -> `UpdateStatus`. `UpdateService` asks `https://registry.npmjs.org/codeden/latest` at most once a day (or on `refresh`), only while `settings.updates.check` is on; `CODEDEN_UPDATE_CHECK=0` turns it off (tests set it). The UI shows the result in Settings > About and a one-time toast per new version.

## Autonomy modes, the software factory and the dark factory (§10.1, experimental)

`FactoryService` (`src/services/factory/`) owns autonomy modes, the vision, kill switches, the factory loop and its pipelines, the dark factory's scout, merge checks, digests and the panel status. Shapes: `@codeden/contracts` `factory.ts`, `factory-api.ts`, `factory-pipeline.ts`. Mode, limits and the project kill switch live on the project row; the global kill switch is `settings.factory.killSwitch`; the loop (with the scout's state), items (with merge-check results) and digests are event-sourced (`factory.loop.updated`, `factory.item.updated`, `factory.digest.created` -> `factory_loops`, `factory_items`, `factory_digests`), so a restart resumes the loop. Items and loops written by older versions are read with the newer fields filled in (`withItemDefaults`, `upgradeLoop` in `store.ts`).

- **Modes.** `manual`, `assisted` (default), `software_factory`, `dark_factory` (`autopilot`, the software factory's id before 0.6, is read as `software_factory` by the `AutonomyMode` schema, so old events and clients keep working). The factory modes need a GitHub project, `.codeden/VISION.md` and limits with a daily budget (`usd` or `tokens`), and report `experimental: true`.
- **Vision.** Saving writes `.codeden/VISION.md` in the main checkout (the loop reads it from there right away, uncommitted) and, in GitHub projects, commits it through the Git Data API to the `codeden/vision` branch and opens (or updates) a small PR "Update the project vision". `##` sections (goals, target users, principles, out of scope, quality bar, protected areas); protected-area bullets in backticks (or path-like) are globs, plain words are topics.
- **Trust** (`trust.ts`, `intake.ts`). New issues (opened after the mode was enabled, or labelled `codeden-factory`) become items. Only issues by trusted authors (`limits.trustedAuthors` plus the login `gh` is signed in as, case-insensitive) are taken on (`trust: "trusted"`); others become `ignored` items (`trust: "untrusted"`) with no model call, session or comment. While the GitHub login is unknown, issues by authors not listed by name wait instead of being ignored. Ignored items move on when their author becomes trusted and stop when the issue closes. `admit` (UI `POST .../factory/admit`, PM `factory_admit_issue`) lets one in as `trust: "admitted"`; `mayAutoMerge` never merges admitted work. Labels never grant trust.
- **Identify type** (`classify.ts`). Trusted candidates are classified (a few per tick) as `bug`, `feature` or `docs`: a GitHub label first, then one utility-model call (`UtilityService.complete`, JSON answer parsed strictly), then keywords. The issue gets `codeden-factory` and `factory:<type>` labels and a comment naming its pipeline; the item goes to `backlog`. Items without an issue (from before 0.6) get one created. A failed check on the default branch becomes a `bug` item with an issue, already reproduced.
- **Agents** (`loop.ts` `assignAgents`). Queued items go to free slots under `maxConcurrentSessions`, by priority (`score`) then age; with auto-merge on, also within `maxMergesPerDay`. An item whose issue was closed stops. Builders are ordinary agent sessions (`issue:<n>`) started by `{ kind: "pm", id: "factory" }`, with the §8.4 conflict check.
- **Pipelines** (`pipeline.ts`, `progress.ts`, `prompts.ts`). A bug's builder first reproduces (`factory_report_reproduction`), a feature's first analyzes (`factory_submit_analysis`, spec and acceptance criteria); the tool's answer is the next step (Create fix, Implement), so the same session carries on. Not reproduced, `already_done`, `needs_info` and `out_of_scope` stop the item (`rejected`) with a comment on the issue and a low inbox item; `retry` queues it again. A builder that ends its turn without its first report is nudged once, then the item fails. The step an item is at is `pipelineStep(item)` (contracts), which the UI draws.
- **Merge checks** (`checks.ts`, all recorded per item): `protected_paths` (escalates to a `pr_review` inbox item), `size`, `ci`, `review` (an independent reviewer session `factory:review:<pr>` on another provider than the builder when one is available; verdict through `factory_submit_review`; skipped for docs-only changes of `docs` items), `tests`, `test_results` (a `## Test results` section in the PR body, or test output attached with `attach_evidence` by the GitHub account CodeDen uses; skipped when no code changed), `security` (`tuning.auditCommand` plus the reviewer's concerns), `ui_evidence` (UI files need screenshots). A failure starts a revise round with the builder (`maxFixAttempts`, default 2), then the item fails and is counted.
- **Merge** (`merge.ts`). With every check green: `mayAutoMerge` (auto-merge on and trusted work) squash-merges within `maxMergesPerDay` and watches CI on the merge commit (a failure opens a revert PR and pauses the loop); otherwise the item waits at Merge with an `inbox:factory-ready:<item>` `pr_review` item and a PR comment until a person merges (`merged`) or closes (`rejected`) it on GitHub. Escalated items finish the same way, read from the PR projection.
- **The scout** (dark factory, `scout.ts`, `scout-reports.ts`, `prompts-scout.ts`). When fewer than `minBacklog` items wait, `discoveryIntervalMin` has passed and an agent slot is free, a round starts: the long-lived scout session (`factory:scout`, reused round after round) plans with `factory_plan_round`; at most `discoveryPerRound` area reviewers (one long-lived session per review area, work key `factory:lens:<area>`, reused; the code calls them lenses) start, within free slots (not counting the scout's own, which it gives back when its planning turn ends; `pickLenses` says why each dropped area got no reviewer); they report with `factory_report_findings`; the scout files at most `maxIssuesPerRound` issues with `factory_file_issue` (queued straight away, typed). Reports that change the loop run through the same per-project chain as ticks (`serialize`). A round over three hours is closed.
- **Limits** enforced by the server: `maxConcurrentSessions`, `maxMergesPerDay`, the daily budget (`UsageService.spendSince`; pauses until the next day; `budgetScope`), `pauseAfterConsecutiveFailures`, protected paths, no deploy files unless allowed, and the kill switches (one call stops the loop and every factory session, scout and its area reviewers included; building items go back to the queue).
- **Intake.** In factory modes the loop is the only intake for issues: issue-triggered triage and `start_session` automations are skipped with `factory_intake` (see Automations, Intake ownership).
- **Digest.** Once per local day (and on demand): shipped, rejected/failed with reasons, decisions, spend against the budget, waiting on you; stored, raised as an `automation_result` inbox item and sent to the orchestrator as a `factory.update` notice.

| Route | Body / response |
|---|---|
| `GET /api/projects/:id/factory` | -> `FactoryStatus` (loop state, items with their pipeline step, ignored issues, the scout, merge checks, spend vs budget, kill switches) |
| `PUT /api/projects/:id/autonomy` | `SetAutonomyModeRequest` -> `SetAutonomyModeResponse` (`409 vision_required`, `400 limits_required` / `budget_required`, `409 not_a_github_project`) |
| `GET\|PUT /api/projects/:id/vision` | `PutVisionRequest` -> `VisionResponse` |
| `POST /api/projects/:id/kill-switch`, `POST /api/factory/kill-switch` | `KillSwitchRequest` -> `KillSwitchResponse` |
| `POST /api/projects/:id/factory/resume` | -> `FactoryLoop` (clears a pause and the failure count) |
| `POST /api/projects/:id/factory/tick` | -> `FactoryStatus` (run one step now) |
| `POST /api/projects/:id/factory/digest` | -> `FactoryDigest` (today's digest now) |
| `POST /api/projects/:id/factory/admit` | `FactoryAdmitRequest` -> `FactoryItemResponse` |
| `POST /api/projects/:id/factory/set-type` | `FactorySetTypeRequest` -> `FactoryItemResponse` |
| `POST /api/projects/:id/factory/items/:itemId/retry` | -> `FactoryItemResponse` |
| `GET /api/projects/:id/factory/items/:itemId` | -> `FactoryItemResponse` |

Tools (`src/mcp/tools/factory/`): builders `factory_report_reproduction`, `factory_submit_analysis` (listed only to a session building a factory item); reviewers `factory_submit_review` (`factory:review:*`); the scout `factory_plan_round`, `factory_file_issue`; area reviewers `factory_report_findings`; PM `factory_status`, `factory_admit_issue`, `factory_set_type`, `factory_allow_large_change` (factory-mode projects); `factory_record_decision` for unattended dark-factory sessions.

## Tests

```sh
pnpm --filter @codeden/server test        # unit + integration (real runner, Fake provider)
pnpm --filter @codeden/server test:live   # real Claude and Codex sessions end to end (small cost)
```

Server tests run the runner without the real Claude/Codex adapters (`CODEDEN_BUILTIN_PROVIDERS=0`), so they never reach a live agent or the utility model.

From the repo root, `pnpm test` runs the suites that drive real processes with timing-sensitive waits (Chromium, terminals, detached runners: `RUNNER_PROCESS_TESTS` / `SERVER_PROCESS_TESTS` in `vitest.config.ts`) after the parallel batch, one file at a time, so a loaded machine cannot starve their waits. `CODEDEN_LIVE=1 CODEDEN_LIVE_GITHUB=1 pnpm --filter @codeden/server test:live -- github` runs the GitHub flow against a new private `codeden-sandbox-<random>` repository (issue, PR from a Fake session, evidence, commit statuses as checks, squash merge, follow-up) and deletes it when the `gh` token has `delete_repo`; `CODEDEN_LIVE_GITHUB_REPO=codeden-sandbox-<id>` reuses a leftover one. Unit tests use a fake GitHub behind Octokit's `fetch` (`test/support/fake-github.ts`). `pnpm test:live` (`CODEDEN_LIVE=1`) also runs `test/live/workbench.live.test.ts`: a real Claude session drives the browser tools, and the Codex engine generates an image through `generate_image`.
