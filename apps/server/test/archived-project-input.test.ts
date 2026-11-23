import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, QueueSender, Session, UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

// Issue #624: a message to a session of an archived project still ran a turn. Archiving makes
// the project's sessions read-only: their transcripts stay, but no input reaches them.

let dir: string;
let database: Database;
let repo: SessionRepo;
let outbox: Outbox;
/** When the project was archived (null: it is active). */
let archivedAt: string | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-archived-"));
  database = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(database.db);
  const session: Session = { ...sampleSession, projectId: "p1", scope: { projectId: "p1" } };
  store.append([{ type: "session.created", sessionId: "s1", payload: { session } }]);
  repo = new SessionRepo(database.db, store);
  outbox = new Outbox(database.db, store);
  archivedAt = "2026-11-20T09:00:00.000Z";
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

const input = (text: string): UserInput => ({ text, attachments: [] });

/** A session service over the real repo and outbox, with a scripted runner that records. */
function service(status: Session["status"]) {
  repo.update("s1", (s) => ({ ...s, status }));
  const runner = {
    isConnected: () => true,
    providers: () => [],
    request: vi.fn(async () => ({})),
  };
  const projects = {
    get: (id: string) => ({ id, name: "app", archivedAt }) as Project,
  } as unknown as ProjectService;
  const sessions = new SessionService({
    repo,
    runner: runner as unknown as RunnerPort,
    outbox,
    projects,
    launcher: { fail: vi.fn(), resume: vi.fn() } as unknown as SessionLauncher,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
    outboxRetryMs: 1_000,
  } as unknown as SessionServiceDeps);
  return { sessions, runner };
}

const REFUSED = {
  status: 400,
  code: "project_archived",
  message:
    "This project is archived, so its sessions are read-only. Add its folder again to restore it.",
};

describe("a session of an archived project", () => {
  it.each<[QueueSender, Session["status"]]>([
    ["user", "idle"],
    ["pm", "idle"],
    ["orchestrator", "idle"],
    ["codeden", "interrupted"],
    ["factory", "running"],
    ["pm", "queued"],
  ])(
    "refuses a message from %s while %s, and nothing reaches the runner or the queue",
    async (from, status) => {
      const { sessions, runner } = service(status);

      await expect(
        sessions.send("s1", { input: input("Carry on"), whenBusy: "queue" }, from),
      ).rejects.toMatchObject(REFUSED);
      expect(runner.request).not.toHaveBeenCalled();
      expect(outbox.count("s1")).toBe(0);
      expect(repo.get("s1").status).toBe(status);
    },
  );

  it("refuses steering a running turn and compacting", async () => {
    const { sessions, runner } = service("running");
    await expect(sessions.steer("s1", input("Also do this"))).rejects.toMatchObject(REFUSED);
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await expect(sessions.compact("s1")).rejects.toMatchObject(REFUSED);
    expect(runner.request).not.toHaveBeenCalled();
  });

  it("keeps a message queued before the archive undelivered", async () => {
    archivedAt = null;
    const { sessions, runner } = service("running");
    await sessions.send("s1", { input: input("Queued earlier"), whenBusy: "queue" }, "pm");
    expect(outbox.count("s1")).toBe(1);

    archivedAt = "2026-11-20T09:00:00.000Z";
    repo.update("s1", (s) => ({ ...s, status: "idle" }));
    await sessions.flushOutbox("s1");
    await sessions.continueAfterRestart("s1", "Carry on where you left off");

    expect(runner.request).not.toHaveBeenCalled();
    expect(outbox.list("s1").map((m) => m.input.text)).toEqual(["Queued earlier"]);
    expect(repo.get("s1").status).toBe("idle");
  });

  it("takes messages again once its project is active", async () => {
    archivedAt = null;
    const { sessions, runner } = service("idle");
    await expect(
      sessions.send("s1", { input: input("Carry on"), whenBusy: "queue" }),
    ).resolves.toEqual({ status: "sent" });
    expect(runner.request).toHaveBeenCalledWith(
      expect.objectContaining({ name: "session.send", sessionId: "s1" }),
    );
  });
});
