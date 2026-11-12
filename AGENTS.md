# CodeDen: agent guide

CodeDen is a local-first harness for coding agents. **`docs/DESIGN.md` is the locked design and the source of truth.** Read the relevant sections before changing behaviour; anything in its "Locked decisions" table needs a design discussion first.

## Layout

```
apps/
  server/     Hono server: security, SQLite event log + projections (Drizzle), UI WebSocket, RunnerClient
  runner/     Runner process: provider sessions, event journal, lock file, WebSocket protocol server
  web/        React 19 + Vite SPA (Tailwind v4, shadcn/ui, TanStack Router + Query, Zustand)
  cli/        The published `codeden` package: CLI entry, bundles server + runner + web with tsdown
  desktop/    The desktop app (Electron): main process, preload bridge, server host, electron-builder packaging
packages/
  contracts/  zod schemas for everything that crosses a boundary (events, entities, protocols, settings)
  providers/  ProviderAdapter / ProviderSession interfaces, the Fake provider, Claude/Codex stubs
docs/DESIGN.md
changes/      Changelog fragments: one file per user-facing change, assembled into CHANGELOG.md at release
scripts/release/  bump-version.mjs (the Release workflow's version bump) and changes.mjs (fragments)
```

Key entry points:
- Contracts: `packages/contracts/src/` (agent events `agent-events.ts`, items `items.ts`, runner protocol `runner/`, UI WebSocket `ws.ts`, persisted events `events.ts`, work/conflicts `work.ts`, factory `factory.ts`).
- Server: `apps/server/src/server.ts` (`startServer({ port, dataDir, token })`), dev entry `src/dev.ts`.
- Runner: `apps/runner/src/runner.ts` (`startRunner`), process entry `src/main.ts`.
- Web shell: `apps/web/src/components/shell/`.
- CLI: `apps/cli/src/cli.ts`.
- Desktop: `apps/desktop/src/main/main.ts` (entry), `desktop-app.ts` (wiring), `src/server/host.ts` (server child), `src/preload/preload.ts` (`window.codedenDesktop`); the UI side is `apps/web/src/lib/platform-desktop.ts`. User guide: `docs/desktop.md`.

## Commands

Node 24+ and pnpm 10 (`corepack enable`).

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace |
| `pnpm dev` | Server on 127.0.0.1:4318 (data in `.codeden-dev/`, Fake provider on) + Vite on http://localhost:5173 |
| `pnpm build` | Build the web app, then bundle `apps/cli/dist` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` / `pnpm format` | Biome check / Biome fix + format |
| `pnpm test` | Vitest, the fast suites (what CI and the release run) |
| `pnpm test:slow` | The real-browser and real-process suites (Chromium, terminals, detached runners). Not in CI; run them when working in those areas |
| `pnpm e2e` | Not in CI. Build the web app and the CLI, then Playwright (`apps/web/e2e`) against a real server + runner with an isolated home and the Fake provider; the update spec also runs the built CLI against a local fake npm registry (first run: `pnpm --filter @codeden/web exec playwright install chromium`) |
| `pnpm desktop:dev` | Build the web UI and the desktop bundle, then run the desktop app from the checkout with home `.codeden-dev/` and the Fake provider (attaches to `pnpm dev`'s server when it runs). Pass options after `--`, e.g. `pnpm desktop:dev -- --home <dir>` |
| `pnpm desktop:build` | `pnpm build`, then the unpacked desktop app for this OS in `apps/desktop/release/` (`pnpm desktop:dist` builds the installers) |
| `pnpm e2e:desktop` | `pnpm desktop:build`, then Playwright's Electron smoke test against the unpacked app with an isolated home and the Fake provider (plus a local update feed test on Windows). Separate from `pnpm e2e` because packaging is slow |
| `VITE_CODEDEN_MOCK=1 pnpm --filter @codeden/web dev` | The UI against the in-memory mock client, no server needed (dev only; builds always use the real server) |
| `pnpm db:generate` | Generate a Drizzle migration after editing a table file `apps/server/src/db/schema-*.ts` (`schema.ts` is the barrel that re-exports them) |
| `node apps/cli/dist/cli.js --home <dir>` | Run the built CLI (`doctor`, `update`, `stop`, `--port`, `--no-open`). A repository build never switches versions; self-update is tested with the fake registry in `apps/cli/test/support/` |

## Conventions

- **Contracts first.** Any new message, event, entity or setting is added to `packages/contracts` (with JSDoc and a round-trip test) before it is used. Validate at boundaries with the shared schemas.
- **Plain TypeScript**, strict, ESM. **No Effect**, no clever abstractions; mainstream patterns that other agents can follow.
- **Small modules:** keep files under ~400 lines; split by concern.
- **Honest capabilities:** UI and orchestration read `ProviderCapabilities`, never branch on a provider id.
- **Events are append-only.** Projections are written in the same transaction as their event (`apps/server/src/events/`), so they can be rebuilt from the log.
- **Security:** server and runner bind 127.0.0.1 only; every request needs the install token; never log or persist tokens in transcripts.
- **Tests: keep them lean.** The bar is that the app installs and works; CI checks exactly that (typecheck, lint, `pnpm test`, build, the packed CLI installed and started). Add a Vitest unit test (next to the package in `test/`) when logic is easy to get wrong and costly when wrong: the risk classifier and other security checks, contracts round-trips, migrations, parsers, anything that can lose data. Don't add end-to-end, real-browser or real-process tests for a feature unless asked, and keep `pnpm test` fast and deterministic (no real timers or races; use the Fake provider, never live agent turns). Bugs users hit get an issue and a fix, with a regression test when the logic warrants one.
- **Never mention other harnesses or products as inspiration** anywhere: code, comments, docs, commits. Describe CodeDen on its own terms.
- **Commits:** conventional commits (`feat(server): ...`, `fix(runner): ...`, `chore: ...`), one logical change per commit. `pnpm typecheck && pnpm lint && pnpm test` must pass.
- **Changelog notes are fragments.** A user-facing change adds its note as its own file, `changes/<issue>-<slug>.md` (front matter `section: added | changed | deprecated | removed | fixed | security`, then `- ` bullets in the style of `CHANGELOG.md`). Never edit `CHANGELOG.md` for unreleased work, so pull requests never conflict on it. Docs-only and internal changes need no note. Format: `changes/README.md`; `pnpm test` checks it.
- Generated files: `apps/server/drizzle/` (migrations, via drizzle-kit) and `apps/web/src/components/ui/` (shadcn). Add shadcn components with `pnpm dlx shadcn@latest add <name>` from `apps/web`.

## Releasing

The published package is `apps/cli` (`codeden` on npm). `.github/workflows/release.yml` builds, tests, checks versions, publishes and creates a GitHub Release.

1. **Actions > Release > Run workflow** on `main`, and pick **patch**, **minor** or **major**. The workflow runs `scripts/release/bump-version.mjs`, which bumps `apps/cli/package.json`, `apps/desktop/package.json` and `SOURCE_VERSION` in `packages/contracts/src/version.ts` (a test keeps them in sync), assembles the fragments in `changes/` into the new version's section of `CHANGELOG.md` (grouped by section) and deletes them, staging the removal. After typecheck, lint, tests and the build pass, it pushes a `chore(release): X.Y.Z` commit to `main` with its `vX.Y.Z` tag in one atomic push, then releases. Add a fragment in `changes/` as changes land; `pnpm changelog:preview` prints the section the next release would add and changes nothing.
2. Pushing a `vX.Y.Z` tag yourself still releases: run `node scripts/release/bump-version.mjs <patch|minor|major>` and commit what it changed and staged, then tag. The tag must match the package version or the workflow fails.
3. The workflow publishes with `npm publish --provenance --access public` using **npm Trusted Publishing** (OIDC): the `codeden` package on npmjs.com trusts `leonvanzyl/codeden` + `release.yml`, so no token secret is needed. It then creates the GitHub Release as a **draft** with the packed `.tgz`. Provenance requires a public repository. A `desktop` matrix job (Windows, macOS, Linux) then builds the desktop installers and attaches them with the updater metadata (`latest*.yml`, blockmaps) to the same release, and a final `publish` job makes the release public once all three are attached (desktop apps read the latest published release, so they never see one without its update files; if a desktop job fails, re-run it and the release publishes when everything has succeeded). Signing is optional: repository secrets `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows .pfx or macOS Developer ID .p12) and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (notarization); without them the installers are unsigned, and unsigned macOS builds can't update themselves.
4. To rehearse, pick **dry-run** instead: it builds and packs and uploads the tarball and installers as artifacts, without changing the version or publishing. Preview the changelog section locally with `pnpm changelog:preview`.
