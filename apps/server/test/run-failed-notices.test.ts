import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  FactoryLimits,
  type Project,
  type Session,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";

// Issue #275, review: a session has one `run_failed` item, and a further failure updates it in
// place. Raised through `InboxService` (auto-retry giving up, the launcher, Retry), that update
// is appended on its own, and every failure must still reach the PM, the orchestrator and
// `session.failed` automations through a stored notice.

const TOKEN = "t".repeat(32);
let home: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-run-failed-notices-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    github: { sync: false },
  });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

const services = () => (server as RunningServer).services;

/** A project and an agent session a PM started in it, for the orchestrator's request. */
function pmSession(): Session {
  const now = new Date().toISOString();
  const project = {
    id: "p-notices",
    name: "app",
    slug: "app",
    path: home,
    kind: "local",
    github: null,
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as unknown as Project;
  services().store.append([{ type: "project.created", sessionId: null, payload: { project } }]);
  const session: Session = {
    ...sampleSession,
    id: "s-pm-work",
    projectId: project.id,
    role: "agent",
    status: "running",
    purpose: "Fix the parser",
    workKey: "issue:7",
    startedBy: { kind: "pm", id: "pm-1", reportTo: "orchestrator" },
    rootThreadId: null,
    createdAt: now,
    updatedAt: now,
  };
  services().sessionRepo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  });
  return services().sessionRepo.get(session.id);
}

/** Ids of the stored `session.failed` notices for `target`. */
const failedNotices = (target: "pm" | "orchestrator") =>
  services()
    .orchestration.notices.list({ projectId: "p-notices" })
    .filter((n) => n.type === "session.failed" && n.target === target)
    .map((n) => n.id)
    .sort();

describe("every failure of a run is told (#275)", () => {
  it("through InboxService: a further failure, and a closed item opening again", async () => {
    const s = pmSession();
    const first = services().inbox.raiseRunFailed(s, "u1:failed", "Request failed: 401");
    await waitUntil(() => failedNotices("pm").length === 1);
    // The PM had the agent try again; the session fails once more (e.g. the launcher's resume).
    services().inbox.raiseRunFailed(s, "resume", "Request failed: 401 again");
    await waitUntil(() => failedNotices("pm").length === 2);
    expect(services().inbox.get(first.id)).toMatchObject({ status: "open", attempts: 2 });

    // Dismissed, then the same key fails again: the item opens again and counts on.
    services().inbox.close(services().inbox.get(first.id), "dismissed", null);
    services().inbox.raiseRunFailed(s, "u1:failed", "Request failed: 401 a third time");
    await waitUntil(() => failedNotices("pm").length === 3);
    const ids = [first.id, `${first.id}:2`, `${first.id}:3`].map((id) => `session.failed:${id}`);
    expect(failedNotices("pm")).toEqual(ids.sort());
    // The orchestrator asked for this work: it hears every failure too.
    expect(failedNotices("orchestrator")).toHaveLength(3);
  });

  it("when auto-retry gives up on a session whose earlier failure is still open", async () => {
    services().settings.update({ sessions: { autoRetry: false } });
    const s = pmSession();
    const append = (...events: AgentEvent[]) =>
      services().store.append(events.map((e) => agentEventToNewEvent(s.id, e)));
    append(
      { type: "thread.started", thread: { id: "t1" } },
      { type: "turn.started", threadId: "t1", turnId: "u1" },
      { type: "turn.failed", threadId: "t1", turnId: "u1", error: { message: "boom" } },
    );
    await waitUntil(() => failedNotices("pm").length === 1);
    // Re-prompted by the PM, the next turn hits an overloaded API: auto-retry decides (it is off
    // here, so it gives up at once) and raises the failure on the open item.
    append(
      { type: "turn.started", threadId: "t1", turnId: "u2" },
      {
        type: "turn.failed",
        threadId: "t1",
        turnId: "u2",
        error: { message: "Overloaded", kind: "transient" },
      },
    );
    await waitUntil(() => failedNotices("pm").length === 2);
    const open = services()
      .inbox.list({ sessionId: s.id })
      .filter((i) => i.kind === "run_failed");
    expect(open).toEqual([expect.objectContaining({ attempts: 2, body: "Overloaded" })]);
    expect(failedNotices("pm")).toEqual(
      [`session.failed:${open[0]?.id}`, `session.failed:${open[0]?.id}:2`].sort(),
    );
  });
});
