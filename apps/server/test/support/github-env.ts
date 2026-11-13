import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Project,
  RawEventEnvelope,
  RunnerCommandName,
  RunnerCommandOf,
  Session,
} from "@codeden/contracts";
import { type Database, openDatabase } from "../../src/db/client";
import { EventStore } from "../../src/events/store";
import { ArtifactService } from "../../src/services/artifacts";
import type { Exec } from "../../src/services/exec";
import { GithubService } from "../../src/services/github/github-service";
import { InboxService } from "../../src/services/inbox-service";
import { ProjectService } from "../../src/services/projects/project-service";
import type { RunnerPort } from "../../src/services/runner-port";
import { MemorySecretStore } from "../../src/services/secrets";
import { SessionRepo } from "../../src/services/sessions/repo";
import { sampleSession } from "../helpers";
import { FakeGithub } from "./fake-github";

/** A `GithubService` over a real SQLite database and a fake GitHub (no network, no runner). */
export interface GithubEnv {
  dir: string;
  gh: FakeGithub;
  db: Database;
  store: EventStore;
  service: GithubService;
  repo: SessionRepo;
  artifacts: ArtifactService;
  inbox: InboxService;
  secrets: MemorySecretStore;
  /** Tokens `gh auth token` prints, in order (the last one repeats). */
  ghTokens: string[];
  /** Runner commands received. */
  runnerCalls: Array<RunnerCommandOf<RunnerCommandName>>;
  /** Uncommitted files `git.status` reports. */
  dirtyFiles: string[];
  /** When set, a `git.push` without a lease fails with this git error (as after a rebase). */
  pushRejection: string | null;
  events: RawEventEnvelope[];
  githubProject: Project;
  localProject: Project;
  addSession: (patch?: Partial<Session>) => Session;
  /**
   * `gh` signs in as another account: every earlier token is revoked (the next request gets a
   * 401) and `gh auth token` prints `token`, which GitHub knows as `login`.
   */
  switchAccount: (token: string, login: string) => void;
  close: () => void;
}

const ts = "2026-11-07T10:00:00.000Z";

export function createGithubEnv(): GithubEnv {
  const dir = mkdtempSync(join(tmpdir(), "codeden-gh-"));
  const db = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(db.db);
  const events: RawEventEnvelope[] = [];
  store.subscribe((batch) => events.push(...batch));
  const gh = new FakeGithub();
  const env = {
    ghTokens: ["tok-1"],
    runnerCalls: [],
    dirtyFiles: [],
    pushRejection: null,
  } as unknown as GithubEnv;
  let ghCalls = 0;
  const exec: Exec = async (command, args) => {
    if (command === "gh" && args[0] === "auth") {
      const value = env.ghTokens[Math.min(ghCalls++, env.ghTokens.length - 1)] ?? "";
      return {
        code: value ? 0 : 1,
        stdout: `${value}\n`,
        stderr: "",
        notFound: false,
        timedOut: false,
        path: "gh",
      };
    }
    return { code: null, stdout: "", stderr: "", notFound: true, timedOut: false, path: null };
  };
  const runner: RunnerPort = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      env.runnerCalls.push(command);
      if (command.name === "git.status") {
        return {
          branch: "x",
          ahead: 0,
          behind: 0,
          files: env.dirtyFiles.map((path) => ({ path, status: " M" })),
        };
      }
      if (command.name === "git.commit") {
        env.dirtyFiles = [];
        return { commit: "c0ffee1234567" };
      }
      if (command.name === "git.push") {
        if (env.pushRejection && !command.forceWithLease) {
          throw Object.assign(new Error(env.pushRejection), { code: "git_failed" });
        }
        return { remote: "origin", branch: command.branch ?? "x" };
      }
      if (command.name === "session.stop") {
        // Like the real runner: the provider exit is ingested before the request resolves.
        env.repo.update(command.sessionId, (s) => ({ ...s, status: "stopped" }));
      }
      return {};
    }) as RunnerPort["request"],
  };
  const projects = new ProjectService({ db: db.db, store, exec, projectsDir: dir });
  const repo = new SessionRepo(db.db, store);
  mkdirSync(join(dir, "artifacts"));
  const artifacts = new ArtifactService(db.db, store, join(dir, "artifacts"));
  const inbox = new InboxService(db.db, store, () => async () => {});
  const secrets = new MemorySecretStore();
  const base = {
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    autonomyMode: "assisted" as const,
    visionPath: ".codeden/VISION.md",
    factoryLimits: {} as Project["factoryLimits"],
    killSwitch: false,
    timezone: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  };
  const githubProject = {
    ...base,
    id: "p-gh",
    name: "widgets",
    slug: "widgets",
    path: join(dir, "widgets"),
    kind: "github",
    github: {
      owner: gh.owner,
      repo: gh.repo,
      remoteUrl: "https://github.com/acme/widgets.git",
      defaultBranch: "main",
    },
  } as Project;
  const localProject = {
    ...base,
    id: "p-local",
    name: "notes",
    slug: "notes",
    path: join(dir, "notes"),
    kind: "local",
  } as Project;
  store.append([
    { type: "project.created", sessionId: null, payload: { project: githubProject } },
    { type: "project.created", sessionId: null, payload: { project: localProject } },
  ]);
  const service = new GithubService({
    db: db.db,
    store,
    projects,
    repo,
    runner,
    artifacts,
    inbox,
    exec,
    secrets,
    // The data directory holds `artifacts/` like a real home, and is the sessions' worktree.
    home: dir,
    fetch: gh.fetch,
    baseUrl: "https://api.github.test",
  });
  let n = 0;
  Object.assign(env, {
    dir,
    gh,
    db,
    store,
    service,
    repo,
    artifacts,
    inbox,
    secrets,
    events,
    githubProject,
    localProject,
    addSession: (patch: Partial<Session> = {}) => {
      const session: Session = {
        ...sampleSession,
        id: `s${++n}`,
        projectId: githubProject.id,
        status: "idle",
        cwd: dir,
        worktreePath: dir,
        branch: `codeden/task-${n}`,
        baseBranch: "main",
        ...patch,
      };
      repo.create(session, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      });
      return session;
    },
    switchAccount: (token: string, login: string) => {
      gh.validTokens = new Set([token]);
      gh.accounts.set(token, login);
      env.ghTokens = [token];
    },
    close: () => {
      service.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
  return env;
}
