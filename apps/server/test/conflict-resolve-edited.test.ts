import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConflictRecord,
  type InboxItem,
  type ProviderInfo,
  type Session,
  Settings,
  StartSessionRequest,
  type StartSessionRequestInit,
  type WorkSummary,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ArtifactService } from "../src/services/artifacts";
import { InboxService } from "../src/services/inbox-service";
import { ConflictService } from "../src/services/orchestration/conflicts";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

const PROJECT = "p1";

const fake = {
  id: "fake",
  name: "Fake",
  ready: true,
  models: [],
  capabilities: {
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    userQuestions: true,
    subagents: false,
    rollback: false,
    fork: false,
    images: true,
    planMode: false,
    reasoningEffort: false,
    mcp: true,
    skills: false,
  },
} as unknown as ProviderInfo;

let dir: string;
let database: Database;
let store: EventStore;
let repo: SessionRepo;
let inbox: InboxService;
let outbox: Outbox;
let sessions: SessionService;
let conflicts: ConflictService;
let launch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-conflict-edit-"));
  database = openDatabase(":memory:");
  store = new EventStore(database.db);
  repo = new SessionRepo(database.db, store);
  const artifacts = new ArtifactService(database.db, store, join(dir, "artifacts"));
  inbox = new InboxService(database.db, store, () => async () => undefined);
  outbox = new Outbox(database.db, store);
  launch = vi.fn(async () => {});
  sessions = new SessionService({
    repo,
    projects: {
      get: () => ({ id: PROJECT, path: dir, defaultProvider: null, archivedAt: null }),
    },
    runner: { providers: () => [fake], isConnected: () => true },
    settings: { get: () => Settings.parse({}) },
    launcher: { launch },
    inbox,
    outbox,
    artifacts,
  } as unknown as SessionServiceDeps);
  conflicts = new ConflictService({ db: database.db, store, inbox, artifacts, sessions });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The New session draft's start: its text, and the work key field when one was typed. */
const draft = (text: string, over: Partial<StartSessionRequestInit> = {}) =>
  StartSessionRequest.parse({ projectId: PROJECT, provider: "fake", input: { text }, ...over });

/** Running work whose key the draft's text derives (`request:fix-the-login-bug`). */
function runningWork(): Session {
  const session: Session = {
    ...sampleSession,
    id: "s-old",
    projectId: PROJECT,
    purpose: "Fix the login bug",
    workKey: "request:fix-the-login-bug",
    scope: { projectId: PROJECT },
    status: "running",
  };
  repo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  });
  return session;
}

/** Send the draft as the route does: a conflict is recorded and shown on the card. */
async function sendConflicting(req: StartSessionRequest): Promise<ConflictRecord> {
  const result = await sessions.start(req);
  if (result.status !== "conflict") throw new Error(`expected a conflict, got ${result.status}`);
  return conflicts.record(req, result.existing);
}

describe("deciding a conflict after editing a draft with an implicit work key (#187)", () => {
  it("waits for the running work with the edited text", async () => {
    const old = runningWork();
    const record = await sendConflicting(draft("Fix the login bug"));
    expect(record.request.workKey).toBe(old.workKey);

    const edited = draft("Fix the login bug, see the Safari console");
    const out = await conflicts.resolve(record.id, {
      resolution: "wait",
      behindId: old.id,
      start: edited,
    });
    expect(out.result).toMatchObject({ status: "queued", behind: [old.id] });
    if (out.result.status !== "queued") return;
    const queued = repo.get(out.result.sessionId);
    expect(queued).toMatchObject({ status: "queued", workKey: old.workKey });
    expect(repo.find(queued.id)?.startMeta?.pending?.input?.text).toBe(
      "Fix the login bug, see the Safari console",
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("joins the running work with the edited text", async () => {
    const old = runningWork();
    const record = await sendConflicting(draft("Fix the login bug"));

    const edited = draft("Fix the login bug, see the Safari console");
    const out = await conflicts.resolve(record.id, {
      resolution: "join",
      sessionId: old.id,
      start: edited,
    });
    expect(out.result).toEqual({ status: "joined", sessionId: old.id });
    expect(outbox.count(old.id)).toBe(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses an edited request that names another work key, so it is sent again", async () => {
    const old = runningWork();
    const record = await sendConflicting(draft("Fix the login bug"));
    await expect(
      conflicts.resolve(record.id, {
        resolution: "force",
        reason: "x",
        start: draft("Fix the login bug", { workKey: "issue:10" }),
      }),
    ).rejects.toMatchObject({ status: 409, code: "work_key_changed" });
    expect(conflicts.get(record.id).status).toBe("open");
    expect(repo.activeWork(PROJECT).map((w) => w.id)).toEqual([old.id]);
    // The same key, typed explicitly, is the same work.
    const out = await conflicts.resolve(record.id, {
      resolution: "wait",
      start: draft("Fix the login bug, typed key", { workKey: old.workKey }),
    });
    expect(out.result).toMatchObject({ status: "queued", behind: [old.id] });
  });
});

describe("replacing a conflict older than the 500 newest records (#187)", () => {
  it("closes the named conflict and its inbox item however old it is", () => {
    const running: WorkSummary = {
      kind: "session",
      id: "s-old",
      sessionId: "s-old",
      projectId: PROJECT,
      startedBy: { kind: "user" },
      purpose: "Hold the work key",
      workKey: "issue:9",
      scope: { projectId: PROJECT },
      progress: null,
      status: "running",
      startedAt: "2026-11-12T10:00:00.000Z",
    };
    const old = conflicts.record(draft("Fix login", { workKey: "issue:9" }), [running]);
    const oldItem = inbox.get(old.id);

    // 500 newer conflicts from other starters for other work, in one append.
    const newer = Array.from({ length: 500 }, (_, i) => {
      const id = `conflict:newer-${i}`;
      const createdAt = new Date(Date.parse(old.createdAt) + 1000 * (i + 1)).toISOString();
      const startedBy = { kind: "automation" as const, id: `a${i}` };
      const record: ConflictRecord = {
        ...old,
        id,
        request: { ...old.request, workKey: `issue:${1000 + i}`, startedBy },
        createdAt,
      };
      const item: InboxItem = { ...oldItem, id, createdAt, updatedAt: createdAt };
      return [
        { type: "conflict.created" as const, sessionId: null, payload: { conflict: record } },
        { type: "inbox.created" as const, sessionId: null, payload: { item } },
      ];
    });
    store.append(newer.flat());

    const second = conflicts.record(
      draft("Fix signup", { workKey: "issue:10", replacesConflict: old.id }),
      [running],
    );
    expect(conflicts.get(old.id).status).toBe("dismissed");
    expect(inbox.get(old.id)).toMatchObject({
      status: "dismissed",
      resolution: { replacedBy: second.id },
    });
    expect(inbox.get(second.id).status).toBe("open");
    expect(inbox.get("conflict:newer-0").status).toBe("open");
  });
});
