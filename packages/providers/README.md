# @codeden/providers

Provider adapters behind one normalized interface (`ProviderAdapter` / `ProviderSession`, design §7). Every adapter emits only `AgentEvent`s from `@codeden/contracts`.

| Adapter | How | Notes |
|---|---|---|
| `claude` | Claude Agent SDK `query()` with streaming input, `pathToClaudeCodeExecutable` = the user's `claude` | SDK pinned to `0.3.318` (tested with Claude Code 2.1.318); loaded through `loadClaudeSdk()` |
| `codex` | `codex app-server` JSON-RPC over stdio | Types generated from Codex 0.160.1 into `src/codex/protocol/` |
| `fake` | Scripted, deterministic | Demos and tests |
| `replay` | Plays back recorded fixtures | Contract tests; never spawns a CLI |

`getProvider(id)` / `listProviders()` return the built-in real adapters. Each adapter also exposes `utilityModel()` for tool-less one-shots (§7.4). `ApprovalBroker` and the risky-action classifier (`src/policy/`) are provider-neutral.

## Scripts

```sh
pnpm --filter @codeden/providers test            # unit + replay contract tests (no live turns)
pnpm --filter @codeden/providers test:live       # live smoke tests against the installed CLIs (small cost)
pnpm --filter @codeden/providers record:claude   # re-record test/fixtures/claude-*.json
pnpm --filter @codeden/providers record:codex    # re-record test/fixtures/codex-*.json
pnpm --filter @codeden/providers codex:protocol  # regenerate src/codex/protocol from the installed codex
```

Fixtures replace the recording cwd with `<CWD>`, the session id with `<SESSION>` and the OS user name with `user`. `CODEDEN_RECORD_MODEL`, `CODEDEN_LIVE_CLAUDE_MODEL` and `CODEDEN_LIVE_CODEX_MODEL` override the models (Claude defaults to the `haiku` alias, Codex to the user's configured model).

## Loading the Claude Agent SDK (`src/claude/sdk/`)

The SDK is not redistributed in the published `codeden` package. `loadClaudeSdk()` picks the source with `claudeSdkSource()`:

- **workspace** (dev, unit tests, e2e): a plain `import("@anthropic-ai/claude-agent-sdk")` from `node_modules`.
- **deps** (the published bundle, where tsdown defines `__CODEDEN_CLAUDE_SDK_ON_DEMAND__`): `installClaudeSdk()` runs `npm install @anthropic-ai/claude-agent-sdk@<CLAUDE_SDK_VERSION> --omit=optional --omit=peer --prefix <home>/deps` once, then the entry is imported by absolute file URL (`createRequire(...).resolve` + `pathToFileURL`, so Windows paths work). The runner calls `configureClaudeSdk({ depsDir })` at start.

`CODEDEN_CLAUDE_SDK=deps|workspace` overrides the choice. npm runs as `node <npm-cli.js>` (from `npm_execpath`, else the npm next to Node, else `npm` on PATH). Concurrent installs share one promise per process and a `<deps>/.install.lock` file across processes (stale when its pid is gone or after 10 minutes). The JS entry only imports Node built-ins, so the `@anthropic-ai/sdk`, MCP SDK and zod peers are not installed; the platform binary is only looked up when `pathToClaudeCodeExecutable` is missing, which CodeDen always sets. `CLAUDE_SDK_VERSION` must equal the version in `package.json` (a test checks it).

## Autonomy mapping (§11.2)

| Level | Claude | Codex |
|---|---|---|
| supervised | `default` + PreToolUse hook forces every edit/command to ask | `untrusted`, workspace-write sandbox |
| auto | `acceptEdits` + hook asks only when the classifier flags a call | `on-request`, workspace-write, network off |
| full | `bypassPermissions` + hook asks only for writes outside the worktree | `never`, workspace-write, network on |

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
