# Contributing to CodeDen

Thanks for helping. CodeDen is plain TypeScript in a pnpm workspace, and most of it is written with coding agents, so the conventions below favour mainstream patterns that any agent (or person) can follow.

**Before changing behaviour, read the relevant sections of [docs/DESIGN.md](docs/DESIGN.md).** It is the locked design and the source of truth; anything in its "Locked decisions" table needs a design discussion (open an issue) first. [AGENTS.md](AGENTS.md) is the short version for coding agents.

## Development setup

You need **Node.js 24+**, **git**, and **pnpm 10** (`corepack enable` gives you the pinned version).

```sh
git clone https://github.com/leonvanzyl/codeden.git
cd codeden
pnpm install
pnpm dev
```

`pnpm dev` starts the server on `127.0.0.1:4318` (data in `.codeden-dev/`, the scripted **Fake** provider enabled) and the Vite dev server on <http://localhost:5173>. Open the Vite URL; its proxy adds the dev install token for you.

To work on the UI with no server at all:

```sh
VITE_CODEDEN_MOCK=1 pnpm --filter @codeden/web dev
```

That runs the web app against an in-memory mock client (development only; builds always talk to a real server).

To try the built CLI exactly as users get it:

```sh
pnpm build
node apps/cli/dist/cli.js --home .codeden-try --port 4400
node apps/cli/dist/cli.js doctor --home .codeden-try
```

## Layout

```
apps/
  server/     Hono server: security, SQLite event log + projections (Drizzle), UI WebSocket,
              orchestration, MCP tools, automations, factory, GitHub sync
  runner/     Runner process: provider sessions, event journal, terminals, browser, git
  web/        React 19 + Vite SPA (Tailwind v4, shadcn/ui, TanStack Router + Query, Zustand)
  cli/        The published `codeden` package: CLI entry, bundles server + runner + web
packages/
  contracts/  zod schemas for everything that crosses a boundary
  providers/  Provider adapters (Claude, Codex, Fake, Replay) and image engines
docs/         User docs and DESIGN.md
```

Package READMEs go deeper: [apps/server](apps/server/README.md), [packages/providers](packages/providers/README.md), [the runner's browser engine](apps/runner/src/browser/README.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace |
| `pnpm dev` | Server on 127.0.0.1:4318 (Fake provider on) + Vite on http://localhost:5173 |
| `pnpm build` | Build the web app, then bundle `apps/cli/dist` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | Biome check |
| `pnpm format` | Biome fix + format |
| `pnpm test` | Vitest, the fast suites (what CI and the release run) |
| `pnpm test:slow` | The real-browser and real-process suites (Chromium, terminals, detached runners); not in CI |
| `pnpm e2e` | Build the web app, then Playwright against a real server + runner with an isolated home and the Fake provider; not in CI |
| `pnpm db:generate` | Generate a Drizzle migration after editing `apps/server/src/db/schema-*.ts` |

Before you push: **`pnpm typecheck && pnpm lint && pnpm test`** must pass. CI runs the same in one Linux job, then builds, packs the npm tarball, installs it, runs `codeden doctor` and starts it to check the API and the web UI are served. Pull requests that only touch documentation skip it. The **CI result** check sums it up. The slow suites, the Playwright e2e suite and the desktop smoke test aren't part of CI; run them when you work in those areas. The release workflow builds and checks the desktop installers on Windows, macOS and Linux.

## Conventions

- **Contracts first.** Any new message, event, entity or setting goes into `packages/contracts` (with JSDoc and a round-trip test) before it is used. Validate at boundaries with the shared schemas.
- **Plain TypeScript**, strict, ESM. No Effect and no clever abstractions.
- **Small modules.** Keep files under roughly 400 lines; split by concern.
- **Honest capabilities.** UI and orchestration read `ProviderCapabilities`; never branch on a provider id.
- **Events are append-only.** Projections are written in the same transaction as their event (`apps/server/src/events/`), so they can be rebuilt from the log.
- **Security.** Server and runner bind 127.0.0.1 only; every request needs the install token; never log or persist tokens, and never write them into transcripts.
- **Describe CodeDen on its own terms.** Don't mention other harnesses or products as inspiration or comparison anywhere: code, comments, docs or commits.
- **Generated files** (don't edit by hand): `apps/server/drizzle/` (drizzle-kit migrations), `apps/web/src/components/ui/` (shadcn; add components with `pnpm dlx shadcn@latest add <name>` from `apps/web`), and `packages/providers/src/codex/protocol/` (generated from the installed Codex).

### Commits and pull requests

- [Conventional commits](https://www.conventionalcommits.org/): `feat(server): ...`, `fix(runner): ...`, `docs: ...`, `chore: ...`. One logical change per commit.
- Keep pull requests focused, describe the behaviour change and how you tested it, and include screenshots for UI changes.

## Testing

- **Keep tests lean.** Add a Vitest unit test (in the package's `test/` folder) when logic is easy to get wrong and costly when wrong: security checks, contracts, migrations, parsers, anything that can lose data. Skip end-to-end and real-browser tests for features unless they're asked for, and keep `pnpm test` fast and deterministic.
- **Use the Fake provider** (scripted and deterministic) or the **Replay** provider (recorded sessions) in tests, never live agent turns.
- Server tests run the runner without the real Claude and Codex adapters (`CODEDEN_BUILTIN_PROVIDERS=0`), so they never reach a live agent. GitHub is faked behind Octokit's `fetch` (`apps/server/test/support/fake-github.ts`).
- `pnpm test:slow` runs the suites that drive real processes (Chromium, terminals, detached runners), one file at a time so a loaded machine can't starve their waits.
- **End to end:** `pnpm e2e`. On the first run install the browser with `pnpm --filter @codeden/web exec playwright install chromium`.

### Live tests (opt in, small real cost)

Live tests use your real Claude Code, Codex and OpenCode logins, so they are skipped unless `CODEDEN_LIVE=1` is set. The `test:live` scripts set it for you:

```sh
pnpm --filter @codeden/providers test:live    # adapter smoke tests against the installed CLIs
pnpm --filter @codeden/server test:live       # real sessions through server + runner + MCP
```

Some suites need an extra switch because they create real GitHub repositories:

```sh
CODEDEN_LIVE=1 CODEDEN_LIVE_GITHUB=1  pnpm --filter @codeden/server test:live -- github
CODEDEN_LIVE=1 CODEDEN_LIVE_FACTORY=1 pnpm --filter @codeden/server test:live -- factory
```

They create a private `codeden-sandbox-*` / `codeden-factory-sandbox-*` repository and delete it afterwards when your `gh` token has the `delete_repo` scope. `CODEDEN_LIVE_CLAUDE_MODEL` and `CODEDEN_LIVE_CODEX_MODEL` choose the models (Claude defaults to `haiku`).

To re-record the Replay fixtures or regenerate the Codex protocol types, see [packages/providers/README.md](packages/providers/README.md).

## Releasing (maintainers)

The published package is `apps/cli` (`codeden` on npm). Bump the version in `apps/cli/package.json` **and** `CODEDEN_VERSION` in `packages/contracts/src/version.ts` (a test keeps them in sync), update [CHANGELOG.md](CHANGELOG.md), commit, then tag and push `vX.Y.Z`. The release workflow builds, tests, checks the tag against the version, publishes with provenance and creates a GitHub Release. Packing copies the root README into the package (`apps/cli/scripts/copy-readme.mjs`).

## Reporting security issues

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
