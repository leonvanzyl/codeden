import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_SESSION_STATUSES, type Session, SessionStatus } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import { ProjectService } from "../src/services/projects/project-service";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

/**
 * Archiving a project is refused while one of its sessions is working or about to (#574): the
 * worktree cleanup that follows an archive leaves those sessions alone, so a queued one could
 * still start in a project that is no longer listed.
 */

let dir: string;
let database: Database;
let projects: ProjectService;
let sessions: SessionRepo;
let made = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-project-archive-"));
  database = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(database.db);
  projects = new ProjectService({
    db: database.db,
    store,
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
  sessions = new SessionRepo(database.db, store);
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

async function project(name: string): Promise<string> {
  mkdirSync(join(dir, name));
  const created = await projects.create({ source: { type: "local", path: join(dir, name) } });
  return created.project.id;
}

function session(projectId: string, over: Partial<Session>): Session {
  made += 1;
  const s: Session = {
    ...sampleSession,
    id: `s${made}`,
    projectId,
    workKey: `request:${made}`,
    scope: { projectId },
    ...over,
  };
  sessions.create(s, {} as Parameters<SessionRepo["create"]>[1]);
  return s;
}

const listed = () => projects.list().map((p) => p.id);
const FINISHED = SessionStatus.options.filter((s) => !ACTIVE_SESSION_STATUSES.includes(s));

describe("ProjectService.archive", () => {
  it.each([...ACTIVE_SESSION_STATUSES])("refuses while a session is %s", async (status) => {
    const id = await project("app");
    const working = session(id, { status });

    expect(() => projects.archive(id)).toThrow(
      expect.objectContaining({
        status: 409,
        code: "project_has_active_sessions",
        message: "1 session of this project is still working or waiting to start. Stop it first.",
      }),
    );
    expect(listed()).toEqual([id]);

    // Once it is stopped, the archive goes through.
    sessions.update(working.id, (s) => ({ ...s, status: "stopped" }));
    projects.archive(id);
    expect(listed()).toEqual([]);
  });

  it("counts every working session: the PM's and an archived session's too", async () => {
    const id = await project("app");
    session(id, { status: "queued" });
    session(id, { status: "running", role: "pm" });
    session(id, { status: "waiting", archivedAt: new Date().toISOString() });
    session(id, { status: "idle" });

    expect(() => projects.archive(id)).toThrow(
      "3 sessions of this project are still working or waiting to start. Stop them first.",
    );
    expect(listed()).toEqual([id]);
  });

  it("archives a project whose sessions are all idle, finished, stopped or archived", async () => {
    const id = await project("app");
    for (const status of FINISHED) session(id, { status });
    session(id, { status: "stopped", archivedAt: new Date().toISOString() });

    projects.archive(id);
    expect(listed()).toEqual([]);
  });

  it("ignores another project's working sessions, and a project with no sessions", async () => {
    const quiet = await project("quiet");
    const busy = await project("busy");
    session(busy, { status: "running" });

    projects.archive(quiet);
    expect(listed()).toEqual([busy]);
  });
});
