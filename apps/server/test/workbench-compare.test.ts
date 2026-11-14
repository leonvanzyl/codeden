import type { RunnerCommand, Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { RunnerPort, RunnerRouter } from "../src/services/runner-port";
import { SessionRepo } from "../src/services/sessions/repo";
import { WorkbenchService } from "../src/services/workbench/workbench-service";
import { sampleSession } from "./helpers";

const ts = "2026-11-14T10:00:00.000Z";
const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-source",
  "+fork",
  "",
].join("\n");

/** A runner that records commands and answers `git.diff` with one modified file. */
function scriptedRunner(sent: RunnerCommand[]): RunnerPort {
  return {
    isConnected: () => true,
    request: async (command: RunnerCommand) => {
      sent.push(command);
      if (command.name !== "git.diff") throw new Error(`unexpected ${command.name}`);
      return {
        diff: PATCH,
        files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1, binary: false }],
      };
    },
  } as unknown as RunnerPort;
}

let database: Database;
let store: EventStore;
let repo: SessionRepo;
let sent: RunnerCommand[];
let home: RunnerPort;
let sandbox: RunnerPort;
/** Sessions on the sandboxed runner; every other session is on the home runner. */
let sandboxed: Set<string>;
let workbench: WorkbenchService;

function addSession(id: string, patch: Partial<Session> = {}): Session {
  const session: Session = {
    ...sampleSession,
    id,
    projectId: "p1",
    scope: { projectId: "p1" },
    title: `Session ${id}`,
    cwd: `/wt/${id}`,
    worktreePath: `/wt/${id}`,
    branch: `codeden/${id}`,
    ...patch,
  };
  repo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  });
  return session;
}

function addCheckpoint(sessionId: string, index: number, turnId: string | null): void {
  store.append([
    {
      type: "checkpoint.created",
      sessionId,
      payload: {
        checkpoint: {
          sessionId,
          index,
          ref: `refs/codeden/checkpoints/${sessionId}/${index}`,
          commit: `${sessionId}-commit-${index}`,
          turnId,
          createdAt: ts,
        },
      },
    },
  ]);
}

beforeEach(() => {
  database = openDatabase(":memory:");
  store = new EventStore(database.db);
  repo = new SessionRepo(database.db, store);
  sent = [];
  home = scriptedRunner(sent);
  sandbox = scriptedRunner(sent);
  sandboxed = new Set();
  const runners: RunnerRouter = {
    home: () => home,
    forSession: (id) => (sandboxed.has(id) ? sandbox : home),
    forRunnerId: () => home,
  };
  workbench = new WorkbenchService({ db: database.db, repo, runner: home, runners });
  addSession("src");
  addCheckpoint("src", 0, null);
  addCheckpoint("src", 1, "u1");
  addSession("fork", {
    forkedFrom: { sessionId: "src", checkpoint: 1 },
  });
  addCheckpoint("fork", 0, null);
});

afterEach(() => database.close());

describe("compare diffs between sessions", () => {
  it("diffs the other session's latest checkpoint against this worktree", async () => {
    addCheckpoint("src", 2, "u2");
    const result = await workbench.diff("fork", { kind: "compare", sessionId: "src" });
    // The live working tree (no `toRef`) of this session, from the source's newest checkpoint.
    expect(sent).toEqual([{ name: "git.diff", cwd: "/wt/fork", fromRef: "src-commit-2" }]);
    expect(result.scope).toEqual({ kind: "compare", sessionId: "src" });
    expect(result.against).toEqual({ sessionId: "src", index: 2, at: ts });
    expect(result.files).toMatchObject([
      { path: "a.txt", change: "modify", additions: 1, deletions: 1 },
    ]);
    // The scope menu's turns stay this session's own.
    expect(result.turns).toEqual([]);
  });

  it("compares a source with its fork the other way round", async () => {
    const result = await workbench.diff("src", { kind: "compare", sessionId: "fork" });
    expect(sent).toEqual([{ name: "git.diff", cwd: "/wt/src", fromRef: "fork-commit-0" }]);
    expect(result.against).toMatchObject({ sessionId: "fork", index: 0 });
    expect(result.turns.map((t) => t.id)).toEqual(["u1"]);
  });

  it("leaves `against` out of the other scopes", async () => {
    const result = await workbench.diff("fork", { kind: "uncommitted" });
    expect(result.against).toBeUndefined();
  });

  it("refuses what it can't compare, before asking the runner", async () => {
    const refused = (id: string, otherId: string) =>
      workbench.diff(id, { kind: "compare", sessionId: otherId });

    await expect(refused("fork", "fork")).rejects.toMatchObject({
      status: 400,
      code: "compare_same_session",
    });
    await expect(refused("fork", "nope")).rejects.toMatchObject({
      status: 404,
      code: "session_not_found",
    });

    addSession("elsewhere", { projectId: "p2", scope: { projectId: "p2" } });
    addCheckpoint("elsewhere", 0, null);
    await expect(refused("fork", "elsewhere")).rejects.toMatchObject({
      status: 400,
      code: "compare_other_project",
    });
    addSession("loose", { projectId: null, scope: { projectId: null } });
    await expect(refused("loose", "fork")).rejects.toMatchObject({
      status: 400,
      code: "compare_other_project",
    });

    addSession("boxed");
    addCheckpoint("boxed", 0, null);
    sandboxed.add("boxed");
    await expect(refused("fork", "boxed")).rejects.toMatchObject({
      status: 409,
      code: "compare_other_runner",
    });

    addSession("fresh", { forkedFrom: { sessionId: "src", checkpoint: null } });
    await expect(refused("fork", "fresh")).rejects.toMatchObject({
      status: 409,
      code: "no_checkpoints",
      message: '"Session fresh" has no checkpoints yet',
    });

    addSession("cleaned", { worktreeRemovedAt: ts });
    await expect(refused("cleaned", "src")).rejects.toMatchObject({
      status: 409,
      code: "worktree_removed",
    });

    expect(sent).toEqual([]);
  });
});
