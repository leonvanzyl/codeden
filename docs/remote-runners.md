# Remote runners: design and plan

> Status: **proposed 2026-11-12**, from a design spike. Once merged, it is part of the design (`docs/DESIGN.md` §4.2, §4.3, §15.2, §19 point here). Anything marked **Needs the user's decision** touches the network or security rules and stays unchanged until the user decides.

CodeDen should scale out: run self-hosted, and run agents in sandboxes (Docker containers on the same machine, or Upstash Box in the cloud). Each sandbox clones its own copy of the code instead of filling the project folder with worktrees. This document records what the spike verified, the decisions, and a phased plan of shippable pull requests.

## 1. Decisions at a glance

| # | Question | Decision | Why, in one line |
|---|---|---|---|
| 1 | SDKs or CLIs? | **Keep the SDK and protocol adapters.** No batch modes (`claude -p`, `codex exec`) | The adapters already run the CLIs; only stdio has to cross the sandbox boundary (§3) |
| 2 | What runs in the sandbox? | **The whole runner**, unchanged, next to the code | Proven: the packed runner ran a Fake turn in a Linux container with no code change (§13) |
| 3 | How the server talks to a sandboxed runner | **Exec link:** the server starts `codeden runner-link` inside the sandbox through the backend's own stdio channel (`docker exec -i`, Upstash `exec.session`), which splices to the runner's loopback WebSocket | Needs no listener on either side, so the 127.0.0.1 rule holds unchanged. Proven with `docker exec -i` (§13) |
| 4 | Dial-out (runner connects to the server) | **Not in the first phases.** Kept as a later transport for machines the server can't exec into | It needs a server endpoint reachable from the sandbox. **Needs the user's decision** (§7) |
| 5 | Backends | `local` (default, today's worktrees), `docker` (plain Docker Engine), `upstash-box` | Docker works on Linux servers without Docker Desktop. Upstash adds cloud scale (§5) |
| 6 | Docker Sandboxes | **A later backend**, not the base | The `sbx` CLI only drives local sandboxes. It needs a Docker sign-in and runs on fewer platforms; the REST API covers cloud sandboxes on a paid plan (§5.3) |
| 7 | Workspace in a sandbox | **Clone inside the sandbox**, at a path the runner chooses | The server's paths mean nothing in a Linux sandbox (§9) |
| 8 | Files, artifacts, MCP across the link | New runner commands (`fs.*`) and an MCP tunnel over the link | The server reads worktrees from its own disk today, and MCP goes over loopback HTTP; both broke in the experiment (§10, §11) |
| 9 | Orchestrator and PMs | **Stay on the home runner** next to the server | They write no code, are long-lived and wake often; a box each would rarely pause (§15) |
| 10 | Provider credentials | Sent over the link and held in runner memory, never in an image, snapshot or container config | Upstash snapshots carry env vars; `docker inspect` shows `-e` values (§14) |
| 11 | GitHub credentials in a sandbox | Brokered per git operation by the server; agents in a sandbox get no GitHub token | Keeps the user's token out of the agent's reach between operations. **Needs the user's decision** (§9.2) |

## 2. Today's runner, and what assumes "same machine"

The runner (`apps/runner`) hosts provider sessions, the event journal, git and checkpoints, node-pty terminals, Chromium and the MCP proxy. The server (`apps/server/src/runner/client.ts`) is a WebSocket client of exactly one runner:

- **Found by lock file.** The server reads `<home>/runner/runner.json`, checks the pid is alive on this machine, probes `/health`, then dials `ws://127.0.0.1:<port>/runner` (`runner/lock.ts`, `client.ts` `ensureRunner`/`connect`).
- **Loopback only.** The runner binds `127.0.0.1` on a random port and refuses any non-loopback `Host` (`runner.ts` lines 78, 198, 241). It has no `--port` flag.
- **Protocol.** `hello` → `welcome` → `resume`, then commands with results and journaled events acked by `seq` (`connection.ts`). Nothing in it depends on the transport being a WebSocket; it is JSON messages.
- **MCP.** The runner's proxy forwards each agent request over HTTP to the server's loopback `/mcp` (`mcp/proxy.ts`, `HttpMcpUpstream`). The `McpUpstream` interface was left as the seam for tunnelling over the runner connection.

Things that assume the runner shares the server's disk:

| Where | Assumption |
|---|---|
| `services/sessions/launcher.ts` `prepareWorkspace` | The server joins the worktree path (`<home>/wt/<slug>/<id>`) and sends absolute host paths as `repoPath`, `path`, `cwd` |
| `routes/session-files.ts`, `services/files/session-files.ts` | The file tree and viewer read the worktree from the server's disk |
| `mcp/tools/share-to-chat.ts`, `services/github/attach.ts`, `services/sessions/generated-images.ts`, `services/images/image-service.ts` | Shared files, evidence and generated images are read from (or written to) worktree paths by the server |
| `mcp/tools/browser-screenshot.ts` | The runner writes the PNG to a path inside the server's artifacts folder |
| `services/agent-config/*`, `services/factory/vision.ts`, `services/projects/project-config.ts` | Project memory files, the vision file and `.codeden/project.json` are read from the project folder |
| `services/projects/detect.ts`, `project-service.ts` | `git -C <path>` and `git clone` run on the server's machine |

Git, diffs, checkpoints and terminals already go through runner commands (`git.*`, `checkpoint.*`, `pty.*`), so they work over any link.

## 3. SDKs or CLIs?

**Answer: keep the SDKs. The choice is a false one.** Every adapter already runs the provider's CLI as a long-lived process and speaks a structured protocol over its stdio:

| Provider | What CodeDen runs | Process | Protocol |
|---|---|---|---|
| Claude Code | Claude Agent SDK `query()` | the user's `claude` executable (`pathToClaudeCodeExecutable`) | stream-JSON over stdin/stdout |
| Codex | `codex app-server` | the `codex` CLI | JSON-RPC over stdio |
| OpenCode | `opencode serve --stdio` | the `opencode` CLI | v2 HTTP API plus events on a loopback port |

When a sandbox product says it "runs the agent CLI", it is the same binary. Batch modes would lose the live transcript and subagent threads, approvals and questions, steering and interrupt, plan mode, fork, and resume with an interrupted turn, so they stay a last resort we don't need.

**Does the SDK support a custom spawn?** Yes. Agent SDK 0.3.318 (the installed version) has `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`, documented "to run Claude Code in VMs, containers, or remote environments" (`sdk.d.ts` around line 2534). `SpawnOptions` is `{ command, args, cwd, env, signal }`, and a `SpawnedProcess` needs `stdin`, `stdout`, `kill`, `exitCode` and `exit`/`error` events (`sdk.d.ts` line 9990 on). The `signal` fires only after the SDK closed stdin and waited about 2 s, so a container teardown on it is safe.

**Do we need it?** Not with the runner in the sandbox: the adapter spawns `claude` locally inside the sandbox, as today. `spawnClaudeCodeProcess` would only matter for a *split* design, with the adapter on the host and only `claude` in the container. We reject that: Claude's own tools (Bash, Edit) run where `claude` runs, while checkpoints, terminals, the browser, setup scripts and the MCP proxy would stay on the host, giving two filesystems for one session. Codex and OpenCode have no such hook either, so the split would be Claude-only.

## 4. Where the runner runs

**Decision: the whole runner runs inside the sandbox.** DESIGN §4.2 already planned this. It keeps every runner-owned feature working unchanged: provider adapters, the event journal (it survives server restarts and link drops), checkpoints and git, node-pty, Chromium and the MCP proxy. The experiment ran the published bundle (`dist/runner.js` from the packed CLI) in a `node:24-bookworm` container as a non-root user; only the link was new.

The image needs build tools: node-pty 1.1.0 ships prebuilt binaries for macOS and Windows only, so on Linux it compiles at install (`install: node scripts/prebuild.js || node-gyp rebuild`). The experiment image had them; an Upstash snapshot build must `apt-get install build-essential python3` first.

## 5. Execution backends

One interface on the server. A backend makes, finds, pauses and deletes sandboxes, and opens a link to the runner in one:

```ts
interface ExecutionBackend {
  id: "local" | "docker" | "upstash-box";
  capabilities(): BackendCapabilities;              // pause, snapshot, persistentDisk, browser, maxConcurrent
  detect(): Promise<BackendStatus>;                 // installed / signed in / reachable, with the reason
  provision(spec: SandboxSpec): Promise<SandboxRef>; // from an image or snapshot; starts the runner
  openLink(ref: SandboxRef): Promise<RunnerTransport>; // stdio of `codeden runner-link` in the sandbox
  pause(ref: SandboxRef): Promise<void>;
  resume(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef): Promise<void>;
  list(): Promise<SandboxRef[]>;                    // CodeDen's sandboxes, by label, for reconcile and sweep
}
```

`local` is today's lock file and loopback WebSocket wrapped in the same interface; `provision` starts the detached runner process as now.

### 5.1 Comparison

| | `local` (default) | `docker` | `upstash-box` | Docker Sandboxes (later) |
|---|---|---|---|---|
| Where | This machine | Containers on this machine (or a Docker host the user's `docker` CLI points at) | Upstash cloud (AWS, `us-east-1` documented) | microVMs on this machine (`sbx`) |
| Needs | Nothing new | Docker Engine or Docker Desktop | An Upstash account and API key | `sbx` CLI, a Docker sign-in, KVM or Hypervisor Platform |
| Platforms | All | All, including Linux servers without Docker Desktop | Any (it's a cloud API) | macOS 14+ on Apple Silicon only, Windows 11 x64, Ubuntu 24.04+ |
| Isolation | None (the user's account) | Container | "Its own isolated container" (technology not named) | Hypervisor microVM, deny-by-default network |
| Link | Loopback WebSocket | `docker exec -i` | `box.exec.session` (WebSocket with stdin) | `sbx exec -i` |
| Workspace | Worktree in `<home>/wt` | Clone into a per-session volume | Clone into `/workspace/home` | Clone in the VM (`--clone`) or a passthrough mount |
| Cost | Free | Free (local CPU and RAM) | Per active CPU-hour plus storage | Free locally, including commercial use |
| Ships in | Today | Phase 4 | Phase 6 | Later |

### 5.2 `docker`

- **Engine, not Desktop.** It uses the `docker` CLI (`docker run`, `exec -i`, `stop`, `rm`, `volume`, `--format '{{json .}}'`), so it works with Docker Desktop, plain Docker Engine on Linux, Podman's Docker-compatible CLI, and `DOCKER_HOST`/contexts pointing at another machine. No new npm dependency. The Engine API over the socket is an option later if the CLI proves limiting.
- **One container per session**, `--init`, non-root, with CPU and memory limits from settings and labels `codeden.install=<id>`, `codeden.session=<id>`. Its runner home and clone live in a named volume per session, removed with the container.
- **Image.** `codeden-runner:<version>` is built locally on first use from a Dockerfile shipped in the package: Node 24, git, build tools for node-pty, `codeden@<version>`, the Claude Code, Codex and OpenCode CLIs, and Chromium for the browser panel. The experiment image (full `node:24-bookworm`) was 1.94 GB. Publishing a ready image to a registry from the release workflow is faster for users but is an outward-facing release change, so it is an open question (§17).
- **Network.** The default bridge with outbound internet. An allow-list network is a later hardening.

### 5.3 Docker Sandboxes, checked

What they are now (the old `docker sandbox` command prints "deprecated and has been removed"): a separate `sbx` CLI (v0.35.0 found on this machine, v0.53.0 available) that runs each sandbox as a **microVM with its own Docker daemon**.

- **Docker Desktop is not needed**, and local use is free, including commercial use.
- **It needs a Docker sign-in** (`sbx login`) and hardware virtualisation. Platforms: macOS 14+ on Apple Silicon only, Windows 11 x64 with Windows Hypervisor Platform, Ubuntu 24.04+ with KVM.
- **CLI:** `sbx create|run <agent> PATH` (agents include claude, codex, opencode and a plain shell), `sbx exec [-i] [-t]` ("flags match docker exec"), `sbx ports --publish`, `sbx cp`, `sbx template save`, `sbx stop`, `sbx rm`.
- **Programmatic API:** REST (`connect.docker.com/sandboxes`) and the `@docker/sandboxes` SDK, with durable interactive processes, output replay, ports and snapshots. It covers **cloud** sandboxes only and needs a Docker Agentic Platform subscription. For local sandboxes only the CLI was found.
- **Network and credentials:** deny-by-default outbound through a host proxy with an allow-list. Credentials set with `sbx secret set` are injected by the proxy, and "the real value never enters the sandbox". That is a strong property CodeDen's own backends can't match.
- **Workspace:** a direct passthrough mount of a host folder, or `--clone`, which clones inside the VM and exposes it back as a git remote `sandbox-<name>`.

**Verdict.** Good security for a later backend: `sbx exec -i` fits the same exec link, so a `docker-sandboxes` backend is mostly provisioning code. It is not the base, though: it requires a Docker account, excludes Intel Macs, older Linux and most servers without KVM, offers no local API, and its credential proxy has to be configured per provider host. Plain Docker covers every platform CodeDen supports.

### 5.4 `upstash-box`, checked against `@upstash/box` 0.7.10 (2026-10-19) and current docs

| Area | Fact | Matters because |
|---|---|---|
| Exec | `exec.command` is still one HTTP request that resolves when the command ends | Not a link |
| | **New:** `exec.stream` (output chunks over SSE) and **`exec.session`**, a WebSocket with stdin, optional PTY, resize, signals (Node only) | A full-duplex stdio channel: the exec link works with no listener anywhere |
| | A session's process dies when its connection drops; sessions can't be reattached | Fine: the link process is only a splice; the runner runs detached |
| | **New:** `initCommand` runs after create and on every resume | Starts the runner on every resume |
| Lifecycle | Idle boxes auto-pause (1 h free, 6 h paid); **pausing stops all processes**, disk is kept | The runner restarts on resume; sessions resume through provider resume (existing path) |
| | `keepAlive` (no pause) is paid only | Not relied on |
| | `pause`, `resume`, `delete`, labels (5 per box) | Lifecycle and sweep |
| Snapshots | Capture the filesystem and config, **including env vars**. Network policy, init command, size and keep-alive must be passed again on restore | One snapshot per CodeDen version; never put secrets in box env |
| Network | Public URLs per port (`getPublicURL`), public unless a bearer token or basic auth is set | Not used: the exec link needs no inbound port |
| | Outbound `allow-all` by default; custom allow-lists; **private IP ranges always blocked** | A box can't dial a server on a LAN or loopback; only a public endpoint |
| Browser | `browser: true` at create only; `browser.cdpUrl()` gives an authenticated external CDP URL | CodeDen uses its own Chromium in the box instead, the same as Docker (§12) |
| Runtime | node, python, golang, ruby, rust runtimes; sizes small 2 vCPU/4 GB, medium 4/8, large 8/16; user `boxuser` with sudo; `/workspace/home` | The node runtime "already ships claude, codex and opencode" |
| | CPU architecture **not documented**; a box observed earlier was ARM64 Debian 12 | Runner is JS; node-pty compiles; Chromium and the agent CLIs support arm64 |
| Built-in agent | `box.agent.run`/`.stream` with Claude Code, Codex, OpenCode, Cursor and Custom harnesses, on the user's own provider API key only | Not used: no approvals, steering or subscription logins through it |
| Files | read (byte ranges up to 8 MiB), write, list, upload (100 MB per file), non-recursive download | Useful for snapshot builds; the link carries session traffic |
| Limits | Free: 10 concurrent boxes, 5 CPU-hours a month. Pay as you go: $0.10 / $0.20 / $0.40 per active CPU-hour (small/medium/large), storage $0.10 per GB-month including snapshots, 1,000 concurrent | Free tier fits trying it, not a factory. Disk is 10/20–30/30 GB (the docs disagree) |
| Auth | API key, default env `UPSTASH_BOX_API_KEY`; SSH also possible | Stored in the OS keychain (§14) |

**Changed since the 0.7.5 notes:** streaming exec and `exec.session` exist; `initCommand`; ephemeral boxes (TTL up to 3 days, no git or agent); external CDP URLs; sizes; snapshots no longer carry everything. Still unverified: CPU architecture, whether an open `exec.session` keeps a box from auto-pausing, and whether `fromSnapshot` keeps browser access.

## 6. The runner link

A **`RunnerTransport`** on the server replaces the hard-wired `ws` client: `send(text)`, `onMessage`, `onClose`, `close()`. The runner protocol (§4.3) is unchanged on top of it.

| Transport | Who connects | Used by | Listener needed |
|---|---|---|---|
| `loopback` | Server → runner's `127.0.0.1` WebSocket (today) | `local` | Runner on loopback (as today) |
| `exec` | Server starts `codeden runner-link` inside the sandbox through the backend; newline-delimited JSON on its stdin/stdout, spliced to the runner's loopback WebSocket with the token from the runner's own lock file | `docker`, `upstash-box`, later `sbx` and SSH | **None** |
| `dial-out` (later) | Runner → `wss://<server>/runner/attach` with a per-runner secret | Machines the server can't exec into | A server endpoint reachable from the sandbox (§7) |

**Why exec first.** It needs no new credential (the backend's own access, the Docker socket or the Upstash key, already proves the server owns the sandbox), no inbound port anywhere, and no change to the 127.0.0.1 rule. A link that drops (server restart, network blip, Upstash session loss) costs nothing: the runner keeps running and journaling, and the server opens a new link and resumes by `seq`, exactly as after a local server restart. `runner-link` writes only protocol frames to stdout and logs to stderr.

**Runner identity.** `runnerId` stays the journal's id. The server records each sandbox runner in a `runners` table (§8) with its backend and sandbox reference. The `welcome` message gains `platform`, `arch`, `home` and `backend`, so the server never guesses paths or separators.

**Built in Phase 2.**
- **Server.** `RunnerTransport` (`apps/server/src/runner/transport.ts`) is `send(message)`, `close()` and an optional `linkPid`. Each transport is opened with its handlers (`onMessage`, `onClose(detail)`), so nothing it receives and no way it ends is missed. `RunnerClient` runs the handshake, acks and reconnects on top of it.
  - `loopback` (`transport-loopback.ts`) is the old `ws` code; the client still finds or starts the runner through its lock file.
  - `exec` (`transport-exec.ts`) runs over a `LinkProcess`: `stdin`, `stdout`, `stderr`, `pid?`, `kill()` and `onExit(code)`. `spawnLinkProcess` and `execLink(command, args)` make a local child process, the shape `docker exec -i` needs. A cloud exec session can implement the same interface.
  - A runner gets the exec transport through `RunnerSpec.link`. Every reconnect opens a new link, and the client resumes by `seq` as after a server restart.
  - A transport whose handshake fails (a `reject`, a refused journal id, or a link that ends before `welcome`) is closed, so failed attempts leave no sockets or processes behind.
  - `stop()` cancels an attempt at any point, including a loopback socket whose upgrade the runner never answers.
  - A runner reached through a link is not the home runner, so it is untrusted (§8): its events and streams pass the same checks over the link as over loopback.
- **Wire format.** It lives in `packages/contracts/src/runner/link.ts`. Each frame is one compact JSON message per line, at most `RUNNER_LINK_MAX_LINE_BYTES` (16 MiB). Every byte except the `\n` counts, including a `\r` before it.
  - `LinkFrameDecoder` reassembles lines split across chunks. It drops a longer line without buffering it, drops a line that is not JSON, and reports each drop.
  - A command too large for a frame fails at once with `too_large` instead of timing out.
- **Link.** `codeden runner-link [--home <dir>]` lives in `apps/runner/src/link/runner-link.ts`, exported as `@codeden/runner/link`.
  - It reads `<home>/runner/runner.json` and connects to the runner's loopback WebSocket with the lock's token.
  - It splices stdin and stdout to that socket, pausing the socket while stdout is full.
  - It loads no server code, so starting it is quick.
  - Aborting it (in-process) drops its socket at once, even while the upgrade is still pending.
  - Exit codes (`RunnerLinkExit`): 0 when stdin ended, 1 when the link failed or the runner closed it, 2 for bad arguments, 3 when no live runner is in the home, 4 when the runner refused the token.
  - The server's close reason names the code and adds the end of the link's last stderr line. The server holds at most 300 characters of an unfinished stderr line, so a channel that never writes a newline can't grow its memory.
- **Welcome.** The runner reports `process.platform`, `process.arch`, its resolved home and its backend (`--backend`, default `local`); the client keeps them as `hostInfo`.
- **Not added.** No runner `--port` or `--host`, and no new listener.

## 7. Reachability and the network rule: **Needs the user's decision**

The locked rule (§3 "Network exposure", §15): the runner, its MCP proxy and the server's `/mcp` answer on 127.0.0.1 only, always; the UI listener moves to `0.0.0.0` only with opt-in network access.

**With the exec link, no sandbox needs to reach the server, and the rule needs no change for Docker or Upstash Box.** The server makes outbound connections only: to the local Docker daemon, or to Upstash's API over TLS. A laptop behind NAT works.

The question stays open for two later cases:

| Case | Options | Recommendation |
|---|---|---|
| A runner on a machine the server can't exec into (a VPS without SSH access from the server, a pool of workers) | (a) an SSH exec link, which needs no listener; (b) dial-out to a **separate** attach listener (`/runner/attach` only, its own port, off by default, bound to 127.0.0.1 and exposed through the user's own reverse proxy or tunnel such as Cloudflare Tunnel or Tailscale Funnel, per-runner secrets over TLS); (c) a relay both sides dial (rejected: a hosted CodeDen service is against §1, and an Upstash Redis mailbox adds a product and per-message cost) | (a) first; (b) only if asked for, and it needs this decision |
| The self-hosted server's UI from the internet | (a) the user's own VPN (Tailscale), which works today under §15.1; (b) HTTPS behind the user's own reverse proxy with the §15.1 password, open to the internet | (a) for now; (b) is a §15.1 extension and needs this decision |

**A finding from the experiment that matters here.** On Docker Desktop, a container reaches services the host binds to `127.0.0.1` through `host.docker.internal`, and the host sees the peer as `127.0.0.1`. Against CodeDen's server, the default `Host` header was refused (403). A request that sets `Host: 127.0.0.1:<port>` got through to the token check (401 without a token; `/mcp` answered "Missing or invalid CodeDen session token"). So on a Docker Desktop machine, the loopback bind does not keep local containers out; **the install token and the MCP session tokens are the real boundary.** Consequences:

- The install token and the server's own secrets never enter a sandbox.
- MCP session tokens stay per session and are revoked when it ends (already the rule).
- Plain Docker Engine on Linux behaves differently (`host-gateway` reaches the bridge address, not loopback), another reason the link must not rely on the container reaching the host.

## 8. Server: several runners

- **`runners` table** (contracts first, a Drizzle migration): `id`, `backend`, `sandboxRef` (container id or box id), `runnerId` (from the journal, set at first `welcome`), `projectId` and `sessionId` it serves (nullable for the home runner), `state` (`provisioning`, `starting`, `connected`, `disconnected`, `paused`, `stopped`, `failed`, `deleted`), `imageVersion`, `createdAt`, `lastSeenAt`, `lastError`. Lifecycle changes are events (`runner.provisioned`, `runner.paused`, `runner.deleted`), projected in the same transaction as today.
- **`RunnerHub`** owns one `RunnerClient` per live runner, each over its own transport. `runner_state.lastAckedSeq` is already keyed by `runnerId`, so acks need no change.
- **Sandbox runners are untrusted input.** A sandbox runner shares its sandbox with an agent that has a shell; only the home runner is trusted. Checked on the server, before the first sandbox runner connects:
  - **Events against routing** (`events/ingest.ts`). An event that names a session (`agent`, `session.process`, `workspace.setup`, `checkpoint.created`) from a runner other than the home runner is stored only when the session's `runnerId` is that runner's journal id; otherwise it is dropped, logged and acked (so it isn't redelivered). The home runner's events are stored as before.
  - **Journal ids are the runner's own** (`runner/identity.ts`). The journal id keys the ack position and the routing, so a `welcome` reporting an id another record carries (deleted ones too, whose sessions would route to it) is refused: no `runner.connected`, the connection closes and the client retries like any failed connection, with the reason as the runner's last error. A runner other than the home runner must report a **new** id on its first connection: one no session and no ack position (`runner_state`) carries, or it could claim, say, the home runner's id from before a journal reset and be sent the sessions that still route home under it. It then keeps that id; under a new one, sessions routed to its old id would match no record and fall back to the home runner. The home runner may come back with a new id (a reset journal). A backend that assigns journal ids itself must record the id on the runner's record before it places sessions under it. Events and streams sent before an accepted `welcome` are ignored.
  - **Terminals and the browser** (`runner/untrusted.ts`). The server chooses pty ids (`pty.open`), so a runner other than the home runner may send `pty.output` and `pty.exited` only for ptys the server opened or attached on it, and `browser.*` streams only for sessions routed to it; the rest is dropped (`pty.exited` acked). Its ptys are kept in memory, so after a server restart its exits for older ptys are dropped too, which loses nothing: no view is attached, and `pty.attach` reports the exit.
- **Built in Phase 1.** The `runners` table and `RunnerHub` exist (`apps/server/src/runner/hub.ts`), and the home runner is registered as record `home`. `runner.registered` and `runner.deleted` are the lifecycle events so far; `runner.connected`, `runner.disconnected` and `runner.draining` carry the record id. A session's `runnerId` that matches no record routes to the home runner, which covers sessions from before records existed and a home runner whose journal was reset. A session whose own runner is disconnected or deleted fails with `runner_unavailable` naming that runner. New sessions are placed on the home runner until the backends (Phase 4) set `sessions.runnerId` before a start; a fork stays on its source's runner, where the copied conversation and checkpoint are.
- **Routing.** `RunnerPort` (`services/runner-port.ts`) becomes per runner, and services ask `hub.forSession(sessionId)`, which reads `sessions.runnerId` (the column exists today). The services that call the runner today (about a dozen files) change from one shared port to the session's port. Terminal and browser routes find the runner through the session; pty ids are unique per runner, so they are keyed by runner too.
- **The home runner** is today's local runner, registered as `backend: local`. Provider detection, `provider.oneShot` (utility model), image generation through Codex, `mcp.test` and the orchestrator and PMs keep using it.
- **Placement.** A project setting `execution.backend` (`local` default, `docker`, `upstash-box`) with a per-session override at start. A sandboxed agent session gets a **sandbox of its own** by default: clean isolation, simple cleanup, and "each sandbox clones its own copy". A warm pool per project is a later optimisation.
- **Versions.** A sandbox image or snapshot is per CodeDen version. On a version mismatch a sandbox runner is drained like today; its sessions resume in a fresh sandbox, cloned from the session's pushed branch or, if nothing was pushed, from a bundle of its last checkpoint (Phase 7).

## 9. Workspaces in a sandbox

### 9.1 Clone, at a path the runner chooses

`workspace.prepare` gets a `clone` strategy: `{ strategy: "clone", remoteUrl, branch, baseRef, depth? }`. The runner clones into `<runnerHome>/ws/<sessionShort>` and returns `cwd`. For remote runners the server never builds a path; `session.cwd` is an opaque runner-local string, shown as is. Setup commands and `.codeden/project.json` run inside, as today.

The first sandbox phases support **GitHub projects** (clone from `origin`). Local-only projects stay on `local`, and the picker says why. A later phase seeds local-only projects with a `git bundle` sent over the link and brings results back the same way (the server `git fetch`es the bundle into the project).

### 9.2 GitHub credentials: **Needs the user's decision**

Pushes and PRs already run on the server side of the protocol (`create_pull_request` asks the runner for `git.commit` and `git.push`, then calls GitHub from the server). Inside a sandbox, `git` still needs a credential for clone, fetch and push. Note that the Upstash node image configures `credential.helper=store`, which would write a token to disk.

| Option | How | Agent can use `gh` | Exposure |
|---|---|---|---|
| **A. Brokered per operation** (recommended) | For server-initiated `workspace.prepare` and `git.push` only, the server sends the token in the command; the runner hands it to that one git process through `GIT_ASKPASS` with `-c credential.helper=`. Nothing is stored | No: agents use CodeDen's GitHub tools (`create_pull_request`, `attach_evidence`, `comment_on_issue`, `get_pr_status`). Sandboxed sessions' system prompt says so | Only while that git process runs, to a process of the same user that reads its environment |
| B. A token in the sandbox | The user provides a fine-grained token scoped to the repo for sandboxes; it is set as `GH_TOKEN` | Yes | For the sandbox's lifetime, to the agent |
| C. No token in the sandbox | Seed and return code as git bundles through the server; the server pushes | No | None, but large repos are slow to seed over the user's upload |

Running agent processes as a different Unix user from the runner would close the gap in A; it is listed as a later hardening.

## 10. Files, diffs, checkpoints and artifacts

- **Diffs and checkpoints already work** over the link (`git.diff`, `checkpoint.*`); the UI is unchanged.
- **New runner commands:** `fs.list`, `fs.stat`, `fs.read` (byte range, capped at 4 MiB per call, base64), `fs.write`. On the server a `WorkspaceFs` interface has a local implementation (`node:fs`, today's behaviour) and a runner implementation. The modules in the table in §2 move to it.
- **`browser.screenshot`** returns the bytes (or a runner path read with `fs.read`) instead of writing into the server's artifacts folder.
- **Large transfers** (bundles, big artifacts) use a chunked `transfer.*` stream with back-pressure, not one giant JSON message.

## 11. MCP over the link

The runner's proxy keeps its agent-facing address (`http://127.0.0.1:<runnerPort>/mcp` inside the sandbox). For remote runners its upstream is a **`LinkMcpUpstream`**: each MCP HTTP request becomes `mcp.request` frames on the link (method, headers, body), and the server answers with `mcp.response` frames, streaming SSE chunks. The server feeds them to its MCP handler in-process, with the same session-token check, so `/mcp` stays loopback-only. This is the change the `McpUpstream` interface was made for. In the experiment, the HTTP upstream failed inside the container ("CodeDen server unreachable … fetch failed").

## 12. Terminals and the browser

- **Terminals** are already protocol commands (`pty.*`) with output on the `stream` channel, so they work over any link. node-pty compiled and spawned a shell in the experiment container (`pty-ok x86_64`).
- **Browser.** The runner launches Chromium inside the sandbox, as it does locally. The screencast frames travel over the link, so remote links cap frame rate and quality (a setting). This is the same path on Docker and Upstash, which avoids Upstash's `browser: true`-at-create rule and keeps snapshots simple. Upstash's `cdpUrl()` stays an option.
- **Dev servers** an agent starts in the sandbox are reached by the sandbox's browser on `localhost`: no port is exposed, and the user sees them in the panel. Opening one in the user's own browser would need a published port or a Box public URL; that is a later convenience.
- **Native browser views** (desktop app, §17 Phase 2) are local-runner only: a remote runner reports no native engine and the panel uses the screencast.

## 13. The experiment

**Setup** (throwaway, outside the repository, everything removed afterwards): `pnpm build`, `npm pack` of `apps/cli`, an image `FROM node:24-bookworm` with git, the packed `codeden` installed globally, and the runner started as user `agent` with `--home /data --fake --no-builtin`. The server was the unchanged built CLI with a throwaway home and port. Because the server only finds a runner through a lock file with a live local pid, a small host-side stand-in wrote that lock file with its own pid and spliced the server's WebSocket to the container.

**Two links, both worked with the runner and protocol unchanged:**

1. **Dial-out:** a sidecar in the container connected out to `ws://host.docker.internal:4400` (the stand-in bound to `127.0.0.1`), then opened the runner's local WebSocket and spliced the two.
2. **Exec link:** for each server connection, the stand-in ran `docker exec -i <container> node link.mjs`. `link.mjs` (25 lines) reads the runner's lock file, connects to the runner, and turns stdin lines into frames and frames into stdout lines.

**Results:**

| Check | Result |
|---|---|
| Orchestrator session, Fake provider, dial-out link | Turn completed: 27 events persisted (thread, turn, 5 text deltas, a command tool call with output, todo list, follow-ups, usage); `sessions.runnerId` = the container's runner |
| Same over the exec link (`docker exec -i`) | Turn completed: "Echo: hello over docker exec" |
| Server killed and restarted | Re-attached to the same `runnerId` through a fresh link (`runner.connected` at seq 1 and seq 194) and resumed from the journal |
| node-pty in the container | Loaded and spawned `bash` |

**What broke, and the fix in the plan:**

| What broke | Why | Fix (phase) |
|---|---|---|
| Server can't find a runner that isn't a local process | Lock file plus local pid check; one `RunnerClient` | `RunnerHub` and transports (1, 2) |
| Port mapping (`docker run -p`) can't work | Runner binds `127.0.0.1` on a random port, refuses non-loopback `Host`, has no `--port` | Not needed: exec link (2) |
| Agent MCP calls fail: "CodeDen server unreachable … fetch failed" | Proxy upstream is the server's loopback URL | MCP over the link (3) |
| Worktree session failed: "C:\Users\…\repo is not a git repository" | Server sends host paths and joins the worktree path itself | `clone` strategy, runner-chosen paths (3) |
| `git status`: "spawn git ENOENT" though git is installed | The cwd (a Windows path) doesn't exist in the container; a misleading error | Same; the runner should report a missing cwd clearly (3) |
| File tree showed the host's folder, not the container's | `session-files` reads the server's disk | `WorkspaceFs` (3) |
| `repo_root` and orchestrator sessions "worked" | Only because Fake never touches its cwd | Same as above (3) |
| A container reaches the host's loopback services as `127.0.0.1` (Docker Desktop) | Docker Desktop proxies `host.docker.internal` to host loopback | Tokens are the boundary; nothing secret enters sandboxes (§7) |

Not tested: real providers (no live model calls), the browser (no Chromium in the image), Upstash Box (no account; verified from docs and SDK types only).

## 14. Provider credentials in a sandbox

Credentials are stored in the OS keychain on the server's machine (as other secrets, DESIGN §6). After each link handshake the server sends a `runner.credentials` command. The runner keeps them in memory only and passes the relevant ones to each provider process's environment. They are never written into an image, a snapshot, a box's create-time env (snapshots copy env vars) or `docker run -e` (visible in `docker inspect`). They are never logged, and `childEnv` keeps CodeDen's own secrets from agents. A provider process can always read its own credential, as it can locally (`~/.claude/.credentials.json`).

| Provider | Subscription | API key | Caveat |
|---|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`: a one-year token for model requests, needs a Pro, Max, Team or Enterprise plan, and must be made in a real terminal (CodeDen opens one, as for sign-in) | `ANTHROPIC_API_KEY` | `--bare` ignores the OAuth token: the adapter must not pass it. The SDK's `env` option replaces `process.env`, so the adapter merges explicitly |
| Codex | A copy of `~/.codex/auth.json` | `CODEX_API_KEY` / `OPENAI_API_KEY` | OpenAI: "use one auth.json per runner … do not share the same file across concurrent jobs or multiple machines". Codex refreshes about every 8 days and a rotation elsewhere breaks the copy. **API key recommended for sandboxes**; a copied login is allowed with a warning |
| OpenCode | Its own `auth.json` per provider | Provider keys as env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | OAuth-based providers have the same sharing caveat as Codex |

Setup gets a **Sandboxes** section: per provider, which credential sandboxes will use, with a test that starts a throwaway sandbox and runs `<cli> --version` plus the provider's auth status, with no model call.

A proposal awaiting the user's decision, [agent-execution.md](agent-execution.md), adds per-session provider homes and a login broker for sandboxed sessions.

## 15. Orchestrator and PMs

**Recommendation: they stay on the home runner, next to the server.** They write no code (`readOnly` for every non-agent role, `launcher.ts`), and need little more than MCP and a read-only view of the repo, which the server's machine has. They are long-lived and woken by every notice, so a box per PM would rarely pause and would cost CPU-hours for little isolation. On the server's machine MCP calls are the fastest.

If the user wants *all* model traffic to come from sandboxes (a self-hosted server with no agent CLIs installed), one setting, `orchestration.runner`, can place them on a backend later; the mechanism is the same. That is an open question (§17).

## 16. Lifecycle and cost

| Control | `docker` | `upstash-box` |
|---|---|---|
| Idle | Stop the container after N minutes idle (default 30): no running turn, no open terminal, no browser viewer | `box.pause()` after N minutes (default 15), well before Upstash's own 1 h or 6 h auto-pause |
| Wake | `docker start` on send or open; the runner restarts and sessions resume through provider resume (the existing path, with "you were interrupted" when a turn was cut off) | `box.resume()`; `initCommand` restarts the runner; the same resume path |
| Delete | With the session's worktree cleanup (archive, merged PR) | The same, `box.delete()`. Boxes are deleted, not left paused: the free plan's 10 includes paused boxes |
| Orphans | Sweep containers and volumes labelled with this install's id that have no live session | The same with box labels, on start and hourly |
| Caps | Max concurrent containers (default 4) | Max concurrent boxes (default 8, leaving room for the snapshot builder under the free plan's 10) |
| Cost | Local resources, not priced | Box minutes per session recorded in the usage ledger as `compute` rows, marked `estimated` from the size's CPU-hour price; budgets and factory limits (§10.1, §12.6) include them |

Pausing kills processes, so the runner journal (on the box's disk) and provider resume tokens carry sessions across. A session whose sandbox was deleted is restored in a new one from its pushed branch, or from its last checkpoint bundle.

## 17. Open questions for the user

1. **Network (§7).** Approve the exec link as the only remote transport for now, which leaves the 127.0.0.1 rule unchanged? The dial-out attach listener would come later and only on request.
2. **GitHub credentials in sandboxes (§9.2).** A (brokered per operation, agents use CodeDen's GitHub tools, recommended), B (a fine-grained token in the sandbox, agents can use `gh`), or C (no token, git bundles through the server)?
3. **Orchestrator and PMs (§15).** On the home runner (recommended), or in sandboxes too?
4. **Codex subscriptions in sandboxes (§14).** Recommend API keys and allow a copied `auth.json` with a warning, or refuse copies?
5. **Docker image (§5.2).** Build locally on first use (recommended, no release change), or also publish `codeden-runner:<version>` to a registry from the release workflow?
6. **Self-hosted UI from the internet (§7).** VPN only for now (recommended), or design HTTPS with the password sign-in as a §15.1 extension?
7. **Subscription logins in cloud sandboxes.** `claude setup-token` and a copied Codex login are the user's own credentials used by their own CLI (DESIGN §21 risk "Terms for using subscription logins"). Is the user comfortable defaulting to them in Upstash, or should cloud sandboxes default to API keys?

## 18. Phased plan

Each phase is one pull request well under 5,000 changed lines, written as an issue draft. The PM files them after this design is merged; the factory builds them in order. Phases 1 to 3 change nothing a user sees, apart from runner details in Settings. Mapping to the brief: (a) is phases 1–3, (b) is 4, (c) is 6, (d) is 5, (e) is 7, (f) is 8.

### Phase 1: several runners, sessions routed to their runner

**Title:** `feat(server): run several runners at once and route each session to its own`

**Why.** The server talks to exactly one runner. Every remote backend needs several at once.

**Scope.**
- Contracts: `RunnerRecord`, `RunnerBackendId`, runner lifecycle events, with JSDoc and round-trip tests.
- A `runners` table and migration, with events and projections.
- `RunnerHub` holding one `RunnerClient` per runner. The local runner is registered as the home runner (`backend: local`).
- `RunnerPort` per runner, and `hub.forSession(id)` used by the services that call the runner today.
- Terminal and browser routes resolve the session's runner.
- The runner status the UI gets lists runners; the existing single-runner view shows the home runner.

**Out of scope.** Transports, backends, UI pickers.

**Acceptance criteria.**
- [ ] With only the local runner, behaviour is unchanged; `pnpm test` passes.
- [ ] A test with two in-process runners (Fake) shows commands for a session go to the runner in `sessions.runnerId`, and events from both are stored and acked per `runnerId`.
- [ ] A session whose runner is gone fails with `runner_unavailable` naming that runner, not the home runner.
- [ ] Migration test for the new table.

**Size.** About 1,500–2,500 lines. **Depends on:** this design.

### Phase 2: runner transports and `codeden runner-link`

**Title:** `feat(runner): exec link transport (codeden runner-link) behind a RunnerTransport interface`

**Why.** Sandboxed runners are reached through their backend's stdio channel, never a port.

**Scope.**
- A `RunnerTransport` interface in the server, with `loopback` (today's `ws` client, refactored) and `exec` (a child process's stdin/stdout, newline-delimited JSON, one message per line, 16 MiB line limit).
- `codeden runner-link [--home <dir>]` in the CLI. It reads the local lock file, connects to the runner, and splices stdin/stdout to it, with logs on stderr and exit codes for "no runner" and "rejected".
- `welcome` gains `platform`, `arch`, `home` and `backend`, all optional so older runners still parse.
- A runner `--port` and `--host` are **not** added.

**Acceptance criteria.**
- [ ] Unit test: framing round-trip (split lines, very long lines, invalid JSON ignored).
- [ ] Test: a server `exec` transport that spawns `runner-link` against a test runner runs a Fake turn and survives the link being killed (re-link, resume by `seq`, no duplicate events).
- [ ] `runner-link` stdout contains only protocol frames.

**Size.** About 800–1,500 lines. **Depends on:** Phase 1.

### Phase 3: remote-safe workspace, files and MCP

**Title:** `feat: clone workspaces, workspace file access and MCP over the runner link`

**Why.** The experiment's breakages: host paths, server-side file reads, loopback MCP.

**Scope.**
- `workspace.prepare` strategy `clone`, with runner-chosen paths for runners whose `welcome.backend` isn't `local`.
- `fs.list/stat/read/write` and chunked `transfer.*` commands.
- A server `WorkspaceFs` (local and runner implementations), adopted by the modules in §2's table.
- `browser.screenshot` returns bytes.
- `LinkMcpUpstream` in the runner, with `mcp.request`/`mcp.response` frames and the server's in-process MCP handling.
- The runner reports a missing cwd as `cwd_missing`, not `ENOENT` from spawn.
- Brokered git credentials for `clone`/`fetch`/`push` (option A, or whichever the user picks in §17.2).

**Acceptance criteria.**
- [ ] With a test runner whose home is a different folder from the server's (simulating a sandbox), a Fake session with `clone` from a local bare repo: prepares, runs a turn, lists files, reads a file, shows a checkpoint diff, shares an artifact, and makes an MCP call, with nothing read from the server's disk.
- [ ] MCP through the link supports SSE responses and `DELETE`; a bad session token is refused exactly as on `/mcp`.
- [ ] No token appears in logs, journal or events (test greps the journal).
- [ ] Local sessions behave as before.

**Size.** About 2,500–3,500 lines. Split MCP into its own PR if it grows. **Depends on:** Phase 2.

### Phase 4: Docker backend

**Title:** `feat: Docker execution backend (a container per session, runner inside)`

**Scope.**
- The `ExecutionBackend` interface.
- The `docker` backend through the `docker` CLI: detect (version, daemon reachable), image build from a Dockerfile in the package (`codeden-runner:<version>`), provision (container plus volume, labels, limits, non-root, `--init`), `openLink` via `docker exec -i … codeden runner-link`, stop/start/remove, list.
- Credential delivery (`runner.credentials`, §14) with keychain storage and a Sandboxes section in Setup.
- A project setting `execution.backend` (`local` | `docker`) in project settings, GitHub projects only.

**Acceptance criteria.**
- [ ] On a machine with Docker: a project set to `docker` starts an agent session in a new container that clones the repo, runs a Fake turn, streams it, shows diffs and files, opens a terminal, and pushes through `create_pull_request` (with a test remote).
- [ ] Server restart: the session continues in the same container.
- [ ] Archive removes the container and volume.
- [ ] Without Docker the option is disabled with the reason.
- [ ] Unit tests: argument building and output parsing for the `docker` commands (no Docker in `pnpm test`).
- [ ] No secret in `docker inspect`.

**Size.** About 2,000–3,000 lines. **Depends on:** Phase 3.

### Phase 5: runner picker and runner health

**Title:** `feat(web): choose where a session runs, and see runner health`

**Scope.**
- The backend picker in project settings and the new-session form (available backends from `detect`, reasons when unavailable, local-only projects limited to `local`).
- Settings › Runners: every runner with backend, sandbox, state, version, platform and arch, last seen, the session it serves, and Stop and Delete actions.
- A runner chip in the session header.
- An inbox item when provisioning or linking fails.
- The panel hides native-browser affordances for remote runners (by capability).

**Acceptance criteria.**
- [ ] Mock-client stories for each runner state.
- [ ] Choosing `docker` for one session of a `local` project works.
- [ ] A runner failing to provision shows an inbox item with the backend's error.
- [ ] Nothing branches on a backend id where a capability exists.

**Size.** About 1,500–2,500 lines. **Depends on:** Phase 4.

### Phase 6: Upstash Box backend

**Title:** `feat: Upstash Box execution backend`

**Scope.**
- Settings: turn Upstash Box on, an API key into the keychain, a test (list boxes), box size, and the concurrency cap.
- `@upstash/box` installed on demand into `<home>/deps` and pinned, like the Agent SDK (§5 of DESIGN), so `npx codeden` stays lean.
- "Prepare the Upstash image": a builder box (node runtime) installs `build-essential`, `codeden@<version>` and Chromium, then a snapshot `codeden-runner-<version>`, with the builder deleted.
- Provision from the snapshot with `initCommand` starting the runner detached and labels for the sweep. `openLink` through `box.exec.session` running `codeden runner-link`.
- Pause, resume, delete.
- Credentials over the link only, never box env (snapshots copy env).

**Acceptance criteria.**
- [ ] Unit tests against a fake `Box` client: provision, link, re-link after a dropped session, pause and resume (runner restarted by init command, sessions resumed), delete and sweep.
- [ ] A manual check script (not in CI) the user runs with their own key: prepare the image, start a Fake session in a box, see the turn, archive, and confirm the box is gone.
- [ ] The key never appears in logs or events.
- [ ] Verify the open items in §5.4 (architecture, auto-pause with an open session) and record them in this doc.

**Size.** About 2,000–3,000 lines. **Depends on:** Phase 5. **Needs:** an Upstash key from the user for the manual check.

### Phase 7: lifecycle and cost controls

**Title:** `feat(server): idle pause, cleanup, orphan sweep and compute cost for sandboxes`

**Scope.**
- Idle detection (no turn, terminal or browser viewer) leading to pause or stop.
- Wake on send or open, with resume.
- Delete with worktree cleanup.
- An orphan sweep on start and hourly.
- Per-backend concurrency caps with queued starts (the existing "queued" status).
- `compute` usage rows (estimated) and budgets.
- Recreating a deleted sandbox from the pushed branch or a checkpoint bundle.

**Acceptance criteria.**
- [ ] Unit tests with fake backends and an injected clock (no real timers): idle → pause after N minutes, wake on message, the cap queues the next start, the sweep deletes only this install's labelled sandboxes without a live session.
- [ ] Usage reports show compute next to tokens, labelled estimated.

**Size.** About 1,500–2,500 lines. **Depends on:** Phase 6 (Docker parts can land after Phase 4).

### Phase 8: self-hosting guide

**Title:** `docs: self-hosting CodeDen with sandboxed runners`

**Scope.**
- `docs/self-hosting.md`: a server on a VPS (home, port, service unit), the UI over the user's VPN (§15.1), the home runner and agent CLIs on the server, Docker on the same host or Upstash Box, credentials, costs, upgrades (new image or snapshot per version), backups (`codeden.db`), and troubleshooting.
- `codeden doctor` lists backends and their status.

**Acceptance criteria.**
- [ ] Following the guide on a clean Linux VM gives a working Fake session in a Docker sandbox.
- [ ] `doctor` shows backend status.

**Size.** Under 1,000 lines. **Depends on:** Phases 4–7.

### Later, not planned yet

- Local-only projects in sandboxes through git bundles.
- A Docker Sandboxes (`sbx`) backend.
- An SSH backend (the exec link over `ssh`).
- The dial-out transport and attach listener (after the §7 decision).
- Running agent processes as a separate Unix user inside the sandbox.
- Warm sandbox pools per project.
- Exposing a sandbox dev server to the user's own browser.

## 19. Sources

- Claude Agent SDK 0.3.318, installed: `packages/providers/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`spawnClaudeCodeProcess`, `SpawnOptions`, `SpawnedProcess`); Context7 `/websites/code_claude_en_agent-sdk`; https://code.claude.com/docs/en/authentication (`setup-token`).
- `@upstash/box` 0.7.10 type definitions (`dist/client.d.ts`, `dist/types.d.ts`); Context7 `/websites/upstash_box`; https://upstash.com/docs/box/overall/ (shell, live-sessions, how-it-works, snapshots, preview, network-policy, browser, pricing, security).
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/ (architecture, install, security, credentials, local-vs-cloud), https://docs.docker.com/ai/sandboxes-api/, and the local `sbx` help output.
- Codex auth: https://learn.chatgpt.com/docs/auth and its CI/CD page; Context7 `/openai/codex`.
- The experiment in §13, run 2026-11-12 on Windows 11 with Docker Desktop 4.81.0 (engine 29.6.1, linux/amd64).
