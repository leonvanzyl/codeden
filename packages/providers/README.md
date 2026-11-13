# @codeden/providers

Provider adapters behind one normalized interface (`ProviderAdapter` / `ProviderSession`, design §7). Every adapter emits only `AgentEvent`s from `@codeden/contracts`.

| Adapter | How | Notes |
|---|---|---|
| `claude` | Claude Agent SDK `query()` with streaming input, `pathToClaudeCodeExecutable` = the user's `claude` | SDK pinned to `0.3.318` (tested with Claude Code 2.1.318); loaded through `loadClaudeSdk()` |
| `codex` | `codex app-server` JSON-RPC over stdio | Types generated from Codex 0.160.1 into `src/codex/protocol/` |
| `opencode` | A private `opencode serve --stdio` per session, v2 HTTP API + SSE events | Tested with OpenCode 2.2.7 (minimum 2.2.0); route types in `src/opencode/protocol.ts` |
| `cursor` | The Cursor CLI's ACP server (`agent acp`), one per session, through the generic ACP client in `src/acp/` | Agent Client Protocol version 1, typed by hand in `src/acp/protocol.ts`; Cursor's extensions in `src/cursor/extensions.ts` |
| `fake` | Scripted, deterministic | Demos and tests |
| `replay` | Plays back recorded fixtures | Contract tests; never spawns a CLI |

`getProvider(id)` / `listProviders()` return the built-in real adapters. Each adapter except Cursor also exposes `utilityModel()` for tool-less one-shots (§7.4). `ApprovalBroker` and the risky-action classifier (`src/policy/`) are provider-neutral.

## Scripts

```sh
pnpm --filter @codeden/providers test            # unit + replay contract tests (no live turns)
pnpm --filter @codeden/providers test:live       # live smoke tests against the installed CLIs (small cost)
CODEDEN_LIVE=1 pnpm --filter @codeden/providers exec vitest run test/live/opencode.live.test.ts  # OpenCode only
pnpm --filter @codeden/providers record:claude   # re-record test/fixtures/claude-*.json
pnpm --filter @codeden/providers record:codex    # re-record test/fixtures/codex-*.json
pnpm --filter @codeden/providers codex:protocol  # regenerate src/codex/protocol from the installed codex
```

Fixtures replace the recording cwd with `<CWD>`, the session id with `<SESSION>` and the OS user name with `user`. `CODEDEN_RECORD_MODEL`, `CODEDEN_LIVE_CLAUDE_MODEL`, `CODEDEN_LIVE_CODEX_MODEL` and `CODEDEN_LIVE_OPENCODE_MODEL` override the models (Claude defaults to the `haiku` alias, Codex and OpenCode to the user's configured model).

## Loading the Claude Agent SDK (`src/claude/sdk/`)

The SDK is not redistributed in the published `codeden` package. `loadClaudeSdk()` picks the source with `claudeSdkSource()`:

- **workspace** (dev, unit tests, e2e): a plain `import("@anthropic-ai/claude-agent-sdk")` from `node_modules`.
- **deps** (the published bundle, where tsdown defines `__CODEDEN_CLAUDE_SDK_ON_DEMAND__`): `installClaudeSdk()` runs `npm install @anthropic-ai/claude-agent-sdk@<CLAUDE_SDK_VERSION> --omit=optional --omit=peer --prefix <home>/deps` once, then the entry is imported by absolute file URL (`createRequire(...).resolve` + `pathToFileURL`, so Windows paths work). The runner calls `configureClaudeSdk({ depsDir })` at start.

`CODEDEN_CLAUDE_SDK=deps|workspace` overrides the choice. npm runs as `node <npm-cli.js>` (from `npm_execpath`, else the npm next to Node, else `npm` on PATH). Concurrent installs share one promise per process and a `<deps>/.install.lock` file across processes (stale when its pid is gone or after 10 minutes). The JS entry only imports Node built-ins, so the `@anthropic-ai/sdk`, MCP SDK and zod peers are not installed; the platform binary is only looked up when `pathToClaudeCodeExecutable` is missing, which CodeDen always sets. `CLAUDE_SDK_VERSION` must equal the version in `package.json` (a test checks it).

## Autonomy mapping (§11.2)

| Level | Claude | Codex | OpenCode / Cursor |
|---|---|---|---|
| supervised | `default` + PreToolUse hook forces every edit/command to ask | `untrusted`, workspace-write sandbox | every edit and command goes to the user |
| auto | `acceptEdits` + hook asks only when the classifier flags a call | `on-request`, workspace-write, network off | only calls the classifier flags go to the user |
| full | `bypassPermissions` + hook asks only for writes outside the worktree | `never`, workspace-write, network on | only writes outside the worktree go to the user |

OpenCode has no OS sandbox. Its sessions get permission rules that make every `edit`, `shell`, `external_directory` and `webfetch` call ask (`SESSION_PERMISSIONS`), and `OpenCodePolicy` decides each ask with the same classifier as Claude: approved on the spot, refused with a reason, or shown to the user. Because the rules never change, an autonomy change applies from the next tool call (`liveAutonomy`). Read-only roles and the `read_only` level refuse edits and run only read-only commands (`readOnlyCommandDenial`).

## Protocol gotchas

**Claude Agent SDK**
- `canUseTool` only fires for calls the permission flow would prompt for; reads, `acceptEdits` edits and settings allow rules never reach it. A PreToolUse hook returning `permissionDecision: "ask"` routes the call to `canUseTool` in every mode, including `bypassPermissions` (the SDK warns that `canUseTool` is shadowed, but hook asks still arrive). The classifier therefore runs in the hook.
- Plan mode (`permissionMode: "plan"`) sends file edits to `canUseTool` regardless of allow rules, so CodeDen's policy refuses edits (outside Claude's notes folders, where the plan file goes) and writing commands itself while planning. `ExitPlanMode`'s tool_use input may carry no plan; the CLI fills `plan` in from the plan file for `canUseTool`, so the `plan` item is emitted from there. Approving returns `updatedPermissions: [{ type: "setMode" }]` with the level's mode: the CLI applies it before the tool runs, and ExitPlanMode only picks its own mode (the pre-plan mode, or `default`) while still in `plan`. CodeDen sets the mode again once the tool result arrives, with the `bypassPermissions` → `acceptEdits` fallback.
- Agent/Task subagents run in the background by default: the tool result is `async_launched` immediately and completion arrives as `system/task_notification`, possibly after the parent turn's `result`. Subagent output only arrives as full messages (no `stream_event`s) and needs `forwardSubagentText: true`.
- Each streamed `assistant` message carries one content block and often arrives before `content_block_stop`; blocks are matched to stream items by message id and order.
- Thinking blocks come back with empty text plus a signature on current models; they map to `reasoning` items with `redacted: true`.
- `result.modelUsage` and `total_cost_usd` are cumulative for the whole query, so `usage.updated` reports session totals.
- Steering pushes another user message into the streaming input; the CLI folds it in at the next tool boundary. If it ran as its own turn, the first `result` has `queued_turn_count > 0`, and the CodeDen turn stays open until it is 0.
- Models come from the `initialize` control request, which the SDK sends when a streaming `query()` starts, before any user message. `refreshModels()` (`src/claude/models.ts`) starts the CLI with a prompt stream that never yields, reads `supportedModels()`, and closes it: no message is sent, so no model request is made and nothing is billed. It loads no settings (`settingSources: []`, so no user hooks run), persists nothing, uses no tools or MCP servers, and has a 30 s timeout. It runs in the background when the runner starts and on every `provider.detect`, shares one CLI between concurrent calls, keeps the last list when it fails, and is skipped when `claude` is not on PATH or the SDK would first have to be installed (`claudeSdkReady()`; the first session installs it and reports its own list). Because no settings are loaded, an `availableModels` restriction in user settings shows up once a session reports its list.
- Windows: the native installer provides `claude.exe`; npm `.cmd` shims are unwrapped to `node <cli.js>` (Node refuses to spawn `.cmd` without a shell). The SDK's platform binary packages (optional dependencies) are never used. The CLI keeps the cwd locked for a moment after `close()`.

**Codex app-server**
- One JSON message per line, no `jsonrpc` field. Server-to-client request ids start at `0`, so never test them for truthiness.
- `turn/start` responds before `turn/started` arrives; the turn is opened on whichever comes first.
- A thread has a single writer: `thread/resume` fails with "already has an active writer" while another app-server still holds it. `close()` waits for the process to exit, and resume retries briefly before failing with `resume_conflict`.
- MCP servers are injected with `config: { "mcp_servers.<name>": { url, http_headers } }` on `thread/start`/`thread/resume`. That goes over stdin, so tokens never appear on a command line.
- On Windows, commands are wrapped as `pwsh -Command '...'`; `commandActions` carries the readable command (and read/search classification).
- The npm `codex.cmd` shim runs a Node wrapper that spawns the vendored `codex.exe`; the adapter runs `node <codex.js> app-server` and kills the process tree with `taskkill /T`.
- Unknown keys in the user's `~/.codex/config.toml` produce `configWarning` notifications on every start; they are ignored.
- Collab subagents and plan mode are experimental in app-server and not surfaced, so `subagents` and `planMode` are `false` for Codex.
- Models come from `model/list`, which needs no thread: `refreshModels()` runs a short-lived app-server for it (about 1 s on Windows, 20 s timeout) when the runner starts and on every `provider.detect`. The id CodeDen sends back is the `model` slug. `thread/start` accepts any model string, so a bad id only fails at `turn/start`. Current models list `max` (sent as is) and `ultra` (not offered). Older models top out at `xhigh`, so `max` is sent as `xhigh` for them.

**OpenCode (v2 server)**
- **One private server per session.** `opencode serve --stdio --hostname 127.0.0.1 --port 0` prints `{"url": ...}` on stdout, listens on a random port with Basic auth (`OPENCODE_PASSWORD`, a random password per process; user name `opencode`), and exits within ~50 ms when its stdin closes, so it never outlives the runner. Start-up takes 200-400 ms. One server per session because MCP servers are process-wide config (`OPENCODE_CONFIG_CONTENT`) and each CodeDen session has its own role-scoped MCP token. `close()` ends stdin and kills the process tree (`taskkill /T` on Windows) if it lingers; the user's own MCP servers run as its children. The npm `opencode.cmd` shim points at a native `opencode.exe`, which is spawned directly.
- **The user's OpenCode stays theirs.** The server reads the user's config, credentials and sessions (`~/.config/opencode`, `~/.local/share/opencode`). CodeDen adds only an inline config layered on top: its MCP servers (`mcp.servers.<name>`, `type: "remote"`, `headers`, `oauth: false`, and `codemode: false` so the tools are listed directly instead of behind OpenCode's `execute` tool) and an env-guard plugin. A user's own `OPENCODE_CONFIG_CONTENT` is merged underneath, and `plugins` arrays concatenate, so the user's plugins still load. Sessions created by CodeDen are archived in OpenCode's own session list (see Sessions), so they don't clutter the user's OpenCode history.
- **Secrets stay out of the agent's shell.** OpenCode passes its whole environment to shell commands, which would hand the agent the server password (and with it, its own permission requests). A tiny local plugin (`src/opencode/plugin.ts`, written to a private `mkdtemp` folder) removes `OPENCODE_PASSWORD`, `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT` in a shell `create.before` hook. `PUT /session/:id/environment` would also work but stores the whole environment in OpenCode's database, so it is not used. Same-user processes can still read another process's environment with OS tools (`/proc/<pid>/environ`, `ps eww`): this is defence in depth, not a sandbox.
- **Sessions.** `POST /api/session` with `location.directory` = the worktree, the permission rules and the model (`{ providerID, id, variant }`). CodeDen's role prompt goes in a session instruction entry (`PUT /api/experimental/session/:id/instructions/entries/codeden`, rendered as `<context key="codeden">` in the system prompt), with a fallback that prefixes the first prompt. `POST /prompt` (`{ text, files }`) returns once queued; a turn spans one `session.execution.started` ... `succeeded|failed|interrupted` of the root session. OpenCode has no turn ids, so CodeDen makes its own. OpenCode doesn't echo prompts as events, so the session records each prompt as its turn's `user_message` (emitted right after `turn.started`, before any agent output) and each steer once it is queued, with the input as sent: its sender (`from`, so briefs show as brief cards) and attachments, without CodeDen's instructions. Sessions can't be created archived, so CodeDen sends `PATCH /api/session/:id` `{ archived: true }` right after creating one and again on every resume (a no-op once archived). Archived sessions still accept prompts and stay archived (checked on OpenCode 2.2.7). The PATCH is its own best-effort request, so an OpenCode that rejects the field never breaks a session.
- **Events (`GET /api/event`, SSE).** `session.text.*` and `session.reasoning.*` (per `assistantMessageID` + `ordinal`) become messages and reasoning (the streamed text is kept on the open item, so a turn cut off by an interrupt keeps it); `session.tool.input.started` names a tool, `tool.called` carries its input, `tool.success|failed` its content and metadata (`exit` for shell, `files` diffs for edits, `matches` for grep). `session.step.ended|failed` carry each model call's tokens and USD cost, so a turn's usage is their sum, subagents included. OpenCode's `output` excludes reasoning (CodeDen's includes it); a cost of 0 is left out so the ledger can price the model.
- **Permissions.** `permission.asked` (`action`, `resources`, `metadata.files` with the diff for edits, `source.id` = the tool call) is answered with `POST /session/:id/permission/:id/reply` `{ decision: once|always|reject, message }`. A `reject` without a message ends the whole execution; with a message the tool fails with that text and the agent carries on, so CodeDen always sends one. `always` saves the rule for the whole project (every worktree of the repo) in OpenCode's database, so `allow_session` is remembered by CodeDen instead and `always` is never sent. Remembered approvals never override read-only, and a switch to read-only forgets them.
- **Questions.** The `question` tool opens a form (`form.created`, `metadata.kind: "question"`, string and multiselect fields with options); it becomes a `user_question`, answered with `POST /form/:id/reply` `{ answer: { <key>: value } }` or cancelled with `DELETE /form/:id`.
- **Steer, interrupt, resume.** A prompt with `delivery: "steer"` joins the running execution at the next step boundary; if the turn is interrupted first, the steer is delivered with the next prompt. `POST /interrupt` ends with `step.failed` (`aborted`) and `execution.interrupted`. OpenCode keeps sessions in its database, so after a crash or restart a new server continues the same session id (`GET /session/:id`, then `PATCH` its permission rules).
- **Subagents** run as child sessions (`session.created` with `parentID`, linked through the `subagent` tool's `tool.progress` metadata) and become child threads of the `subagent` item (`src/opencode/subagents.ts`).
- **Approved by policy.** Every edit and command asks (see Permissions), so most asks are approved on the spot by CodeDen's policy. Those approvals show no card: the tool call itself is in the transcript from start to finish, as with Claude. Only the asks that need the user become approval cards.
- **Models** come from `GET /api/model` and `/api/model/default` on a short-lived server (no session, no model call; about 1 s on Windows), which also lists providers and credentials for `detect()`. Ids are `<providerID>/<modelID>` (the model id may itself contain slashes). Efforts are the model's `variants` that match CodeDen's (`none` and `thinking` are dropped); an effort a model lacks falls back to its nearest variant. Models without tool calling and deprecated ones are left out.
- **Sign-in.** OpenCode's own free models work without an account (`authMethod: "free"`); providers activated by environment variables or config count as signed in (`"environment"`); saved credentials from `opencode auth login` are `"credentials"`.
- **Utility model.** `POST /api/experimental/generate/text` (`{ prompt, model }`, no tools, no session) on a short-lived server; it takes no system prompt, so `system` goes in front of the prompt. A model chosen in Settings is sent as is. With none, `cheapUtilityModel()` (`src/opencode/models.ts`) reads `/api/model/default` and `/api/model` on the same server and picks the cheapest model from the default model's provider, by listed input + output price per million tokens (the base price, not a context tier), a free one included. Disabled, deprecated and unpriced models are skipped (the default too), and the default wins ties. Staying on the default's provider keeps side jobs on the account the user already chose (an Anthropic default gives Haiku, never another provider's free tier). With no default, no prices or a failed lookup, no model is sent and OpenCode uses its own default.
- **Not wired up yet:** OpenCode's revert (rollback), fork, the `plan` agent (plan mode) and skills, so those capabilities are `false`.

**ACP (`src/acp/`) and Cursor (`src/cursor/`)**

- **Generic client.** `AcpSession` takes an `AcpAgentSpec` (command arguments, auth method, mode ids, vendor extensions); nothing in `src/acp/` knows about Cursor. Messages are JSON-RPC 2.0 with `jsonrpc: "2.0"`, one per line; the agent's logs on stderr are kept as a short tail for errors only.
- **Resume replays history.** `session/load` streams the whole conversation as `session/update`s before it answers. The mapper drops updates outside a turn, so the replay never reaches the transcript.
- **Permissions.** Options are picked by `kind`, never by id: `allow_once` or `reject_once`. `allow_always` would save a rule in the agent's own settings, so `allow_session` stays in `AcpPolicy`. A cancelled turn must answer `{ outcome: "cancelled" }`.
- **Titles are the agent's.** Only `other` calls can be MCP calls (`mcpOf`): a command titled `codeden-x; rm -rf ~` is still a command, so CodeDen's trusted-server rule never covers it.
- **Tool call ids can repeat across turns**, so item ids are `<turn>:<toolCallId>`.
- **Only a validated `agent` runs.** `findCursor` accepts `cursor-agent` or an `agent` with Cursor's dated `--version` (`cursorOnly`); the adapter never falls back to an unchecked look-up.
- **Cursor.** `cursor_login` reuses the CLI's login. Models come from `cursor/list_available_models`, else `agent --list-models`, and are set through the `model` config option (Cursor's `session/set_model` answers `{}` without confirming anything, so it is only the fallback). `cursor/ask_question` and `cursor/create_plan` are blocking requests answered with `{ outcome: { outcome: ... } }`; `cursor/update_todos` may arrive as either. `cursor/task` and `cursor/generate_image` are refused with -32601 until subagents and images are wired up.
- **Tests** drive `test/fixtures/fake-acp/agent.mjs`, a scripted ACP agent that also answers the CLI's `--version`, `status` and `--list-models`.

## Image generation (`src/image/`, §12.5)

`ImageEngine` (`id`, `detect()`, `generate()`) with three engines. Each writes the files itself and throws only `ImageGenerationError` (`code`: `unavailable`, `invalid_request`, `auth`, `rate_limited`, `content_policy`, `timeout`, `aborted`, `no_image`, `provider_error`, `io`; plus `retryable` and `details.retryAfter`). Every call takes an `AbortSignal` and a `timeoutMs`.

| Engine | How | Default model | References |
|---|---|---|---|
| `codex` | Ephemeral, tool-restricted `codex app-server` turn under the user's own Codex login (no API key) | the user's configured Codex model | `localImage` input parts |
| `gemini` | REST `POST /v1/models/{model}:generateContent` with `x-goog-api-key`, `responseModalities: [TEXT, IMAGE]`, `imageConfig.{aspectRatio,imageSize}`; one request per image; `thought` parts skipped | `gemini-nano-banana-2.1` | `inlineData` parts |
| `openai` | `POST /v1/images/generations`, or `/v1/images/edits` (JSON `images: [{ image_url: <data URL> }]`) when references are given; reads `b64_json` and `revised_prompt` | `gpt-image-2` | yes |

`ImageEngineRegistry.pickDefault(settings.imageGeneration)`: `none` hides the tool; an explicit engine is used only when available (never silently swapped); `auto` takes a keyless engine first (Codex when logged in), then the first key engine. `resolveImageOutput(worktree, outputPath)` turns the tool's `outputPath` into `{ outputDir, fileStem }` and refuses paths outside the worktree, inside `.git`, or with NUL bytes. Extensions follow the actual bytes (`hero.png`, `hero-2.png`, ...).

Live check (one real image on the user's subscription): `CODEDEN_LIVE=1 pnpm --filter @codeden/providers exec vitest run test/image/codex.live.test.ts`.

### Spike 7: Codex image generation (Codex 0.160.1, ChatGPT login)

- **Use `app-server`, not `exec`.** In app-server the built-in tool shows up as a `ThreadItem` of type `imageGeneration` (`status`, `revisedPrompt`, `result`, `failure`, `savedPath`). `result` is the **base64 PNG**, so CodeDen decodes it and writes the requested path itself. Codex never needs write access, and the turn runs in a `read-only` sandbox. `codex exec --json` emits no item for the image at all (only the agent's text; the file lands only in Codex's cache), and on a default config it loaded the image skill and spent ~99k input tokens for one image.
- **Detection.** `modelProvider/capabilities/read` returns `{ imageGeneration: true }` under the ChatGPT login; `detect()` checks it after `codex login status`. The `image_generation` feature flag is stable and on by default; the turn forces it on anyway.
- **Restricting the turn.** `mcp_servers: {}` in `thread/start.config` does not remove the user's servers (it merges). What works: read `config/read` and set `mcp_servers.<name>.enabled = false` for each, plus `features.{plugins,remote_plugin,apps,tool_suggest,skill_search,browser_use,computer_use,code_mode_host,multi_agent,goals,hooks} = false` and `web_search = "disabled"`. With that no MCP server starts and input drops from ~21k to ~15k tokens. Approvals are `never` and every server request is declined.
- **Shape.** The tool follows the prompt: "landscape (1536x1024)" gives 1536x1024, "portrait (1024x1536)" gives 1024x1536, and square gives **1254x1254** (not 1024). Sizes are not exact, so `capabilities.exactSize` is false for Codex.
- **Count.** Asking for N images makes the model call the tool N times in one turn. CodeDen resolves as soon as N items arrived and closes the server, which skips the closing message (~3 s).
- **References.** `localImage` parts work for edits and variations (the revised prompt starts "Edit the reference...").
- **Latency.** ~2 s to start the app-server and thread, then ~10-20 s per image: 17-38 s end to end for one image, ~44 s for two.
- **Side effect.** Codex keeps a copy in `~/.codex/generated_images/<thread>/<item>.png`, even for ephemeral threads. The engine deletes those copies (only under `$CODEX_HOME/generated_images`) unless `removeCodexCopies: false`.
- **Failure modes.** `item.failure = { type: "usageLimitExceeded", resetsAt }` becomes `rate_limited` with `retryAfter`. Turn errors map through `codexErrorInfo` (`usageLimitExceeded`/`rateLimitExceeded` to `rate_limited`, `unauthorized` to `auth`, policy blocks to `content_policy`). A turn that ends without an image is `no_image` with the model's last message; an app-server exit is `provider_error`.
