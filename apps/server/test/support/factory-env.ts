import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FactoryLimits,
  type Notice,
  type Project,
  type ProviderInfo,
  type ProviderStatus,
  type Session,
  type StartSessionRequest,
  type StartSessionResponse,
} from "@codeden/contracts";
import { type Database, openDatabase } from "../../src/db/client";
import { EventStore } from "../../src/events/store";
import type { Exec, ExecResult } from "../../src/services/exec";
import type { RateLimitReading } from "../../src/services/factory/availability";
import { FactoryService } from "../../src/services/factory/factory-service";
import { VISION_TEMPLATE } from "../../src/services/factory/vision";
import { InboxService } from "../../src/services/inbox-service";
import type { NoticeDraft } from "../../src/services/orchestration/notices";
import { ProjectService } from "../../src/services/projects/project-service";
import type { RunnerPort } from "../../src/services/runner-port";
import { SessionRepo } from "../../src/services/sessions/repo";
import type { SessionService } from "../../src/services/sessions/session-service";
import { SettingsStore } from "../../src/settings-store";
import { sampleSession } from "../helpers";
import { FakeFactoryGithub } from "./fake-factory-github";

/**
 * The factory loop over a real SQLite database and event log, with a scripted session service
 * (sessions are rows the test moves through statuses), a scripted GitHub and a fixed clock.
 * No runner, no providers: the state machine and its limits are what is under test.
 */
export interface FactoryEnv {
  dir: string;
  db: Database;
  store: EventStore;
  repo: SessionRepo;
  inbox: InboxService;
  settings: SettingsStore;
  gh: FakeFactoryGithub;
  factory: FactoryService;
  project: Project;
  /** Start requests the factory made, in order. */
  starts: StartSessionRequest[];
  /** Messages sent to sessions. */
  messages: Array<{ sessionId: string; text: string }>;
  /**
   * The scripted session service the factory uses: every message is sent at once and marks the
   * session running. A test can replace a method (e.g. `send` with a real `SessionService`'s).
   */
  sessions: SessionService;
  stopped: string[];
  /** Sessions the factory archived (through `archiveSession`), in order. */
  archived: string[];
  /** Commands the factory ran (the audit), with their working directory. */
  execs: Array<{ command: string; args: string[]; cwd: string | undefined }>;
  notices: NoticeDraft[];
  spend: { usd: number; tokens: number };
  /** Session filters the budget asked spend for (null: the whole project). */
  spendFilters: Array<string[] | null>;
  providers: string[];
  /** What detection reports per provider, over "installed and signed in". */
  detected: Record<string, Partial<ProviderStatus>>;
  /** How many times the factory asked the runner to detect providers. */
  detections: number;
  /** Rate-limit windows the usage service reports. */
  rateLimits: RateLimitReading[];
  /** The utility model's answer to the "Identify type" call (null: no model). */
  model: (system: string, prompt: string) => Promise<string | null>;
  /** Shift of the factory clock against real time (day rollover, CI grace). */
  clock: { offsetMs: number };
  now: () => Date;
  /** Set a session's status a few ms later (so `updatedAt` moves past earlier nudges). */
  setStatus: (sessionId: string, status: Session["status"]) => Promise<void>;
  /** Recreate the service over the same database (a server restart). */
  restart: () => FactoryService;
  updateProject: (patch: Partial<Project>) => Project;
  close: () => void;
}

export function createFactoryEnv(
  opts: { limits?: Partial<FactoryLimits>; providers?: string[] } = {},
): FactoryEnv {
  const dir = mkdtempSync(join(tmpdir(), "codeden-factory-"));
  const db = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(db.db);
  const repo = new SessionRepo(db.db, store);
  const inbox = new InboxService(db.db, store, () => async () => {});
  const settings = new SettingsStore(join(dir, "settings.json"));
  const execs: FactoryEnv["execs"] = [];
  const exec: Exec = async (command, args, opts): Promise<ExecResult> => {
    execs.push({ command, args, cwd: opts?.cwd });
    // Like spawning a real process: a working directory that doesn't exist can't start.
    if (opts?.cwd && !existsSync(opts.cwd)) throw new Error(`spawn ${command} ENOENT`);
    return { code: 0, stdout: "", stderr: "", notFound: false, timedOut: false, path: null };
  };
  const projects = new ProjectService({ db: db.db, store, exec, projectsDir: dir });
  const gh = new FakeFactoryGithub();
  const repoDir = join(dir, "repo");
  mkdirSync(join(repoDir, ".codeden"), { recursive: true });
  writeFileSync(join(repoDir, ".codeden", "VISION.md"), VISION_TEMPLATE);
  const now = new Date();
  const project = {
    id: "p-app",
    name: "app",
    slug: "app",
    path: repoDir,
    kind: "github",
    github: {
      owner: "acme",
      repo: "app",
      remoteUrl: "https://github.com/acme/app.git",
      defaultBranch: "main",
    },
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({ dailyBudget: { usd: 10 }, ...opts.limits }),
    killSwitch: false,
    timezone: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  } as Project;
  store.append([{ type: "project.created", sessionId: null, payload: { project } }]);
  gh.githubProjects.add(project.id);

  const env = {
    dir,
    db,
    store,
    repo,
    inbox,
    settings,
    gh,
    project,
    starts: [],
    messages: [],
    stopped: [],
    archived: [],
    execs,
    notices: [],
    spend: { usd: 0, tokens: 0 },
    spendFilters: [],
    providers: opts.providers ?? ["claude", "codex"],
    detected: {},
    detections: 0,
    rateLimits: [],
    model: async () => null,
    clock: { offsetMs: 0 },
  } as unknown as FactoryEnv;

  const sessions = {
    start: async (req: StartSessionRequest): Promise<StartSessionResponse> => {
      env.starts.push(req);
      const provider =
        req.provider && req.provider !== "auto" ? req.provider : (env.providers[0] ?? "fake");
      // A reviewer works in the builder's worktree (`existing`): its cwd, not a worktree of its own.
      const existing = req.workspace?.mode === "existing" ? req.workspace.path : undefined;
      const worktreePath = existing ? null : join(dir, "wt", randomUUID().slice(0, 6));
      if (worktreePath) mkdirSync(worktreePath, { recursive: true });
      const session: Session = {
        ...sampleSession,
        id: randomUUID(),
        projectId: req.projectId,
        role: "agent",
        startedBy: req.startedBy,
        purpose: req.purpose ?? "work",
        workKey: req.workKey ?? "request:work",
        scope: { projectId: req.projectId, ...req.scope },
        provider,
        status: "running",
        issue: req.issue ?? null,
        cwd: existing ?? worktreePath ?? dir,
        worktreePath,
        branch: "codeden/x",
        pr: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      repo.create(session, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      });
      return { status: "started", sessionId: session.id };
    },
    send: async (sessionId: string, req: { input: { text: string } }) => {
      env.messages.push({ sessionId, text: req.input.text });
      // Messaging an archived session brings it back, recreating a removed worktree.
      const s = repo.get(sessionId);
      if (s.worktreePath && s.worktreeRemovedAt) mkdirSync(s.worktreePath, { recursive: true });
      repo.update(sessionId, (cur) => ({
        ...cur,
        status: "running",
        archivedAt: null,
        worktreeRemovedAt: null,
      }));
      return { status: "sent" };
    },
    stop: async (sessionId: string) => {
      env.stopped.push(sessionId);
      return repo.update(sessionId, (s) => ({ ...s, status: "stopped" }));
    },
  } as unknown as SessionService;
  env.sessions = sessions;
  const runner = {
    providers: () => env.providers.map((id) => ({ id, displayName: id }) as ProviderInfo),
    isConnected: () => true,
    // Provider detection: installed and signed in unless a test says otherwise.
    request: async (command: { name: string }) => {
      if (command.name !== "provider.detect") throw new Error(`unexpected ${command.name}`);
      env.detections += 1;
      return {
        statuses: env.providers.map((providerId) => ({
          providerId,
          installed: true,
          loggedIn: true,
          supported: true,
          issues: [],
          ...env.detected[providerId],
        })),
      };
    },
  } as unknown as RunnerPort;

  const build = () =>
    new FactoryService({
      db: db.db,
      store,
      projects,
      repo,
      sessions,
      runner,
      usage: {
        spendSince: (_day: string, _projectId?: string, ids?: ReadonlySet<string>) => {
          env.spendFilters.push(ids ? [...ids] : null);
          return env.spend;
        },
        rateLimitWindows: () => env.rateLimits,
      },
      inbox,
      notify: (draft) => {
        env.notices.push(draft);
        return undefined as unknown as Notice;
      },
      settings,
      exec,
      github: gh,
      complete: (_job, system, prompt) => env.model(system, prompt),
      archiveSession: async (sessionId) => {
        env.archived.push(sessionId);
        const at = new Date().toISOString();
        const worktree = repo.get(sessionId).worktreePath;
        if (worktree) rmSync(worktree, { recursive: true, force: true });
        return repo.update(sessionId, (s) => ({
          ...s,
          status: s.status === "idle" ? "stopped" : s.status,
          archivedAt: at,
          worktreeRemovedAt: s.worktreePath ? at : null,
        }));
      },
      options: { autoTick: false, now: () => env.now(), ciGraceMs: 60_000 },
    });
  env.factory = build();
  env.restart = () => {
    env.factory.stop();
    env.factory = build();
    return env.factory;
  };
  env.now = () => new Date(Date.now() + env.clock.offsetMs);
  env.setStatus = async (sessionId, status) => {
    await new Promise((r) => setTimeout(r, 5));
    repo.update(sessionId, (s) => ({ ...s, status }));
  };
  env.updateProject = (patch) => {
    const next = { ...projects.get(project.id), ...patch } as Project;
    store.append([{ type: "project.updated", sessionId: null, payload: { project: next } }]);
    return next;
  };
  env.close = () => {
    env.factory.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return env;
}
