import type { InboxItem, Item, Project, RawEventEnvelope, Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { UNATTENDED_APPROVAL } from "../src/services/factory/unattended";
import {
  isUnwatched,
  noAnswerDenial,
  UnwatchedApprovals,
} from "../src/services/sessions/unwatched-approvals";
import { sampleSession } from "./helpers";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const WAIT = 30 * 60_000;

function approval(id: string, sessionId: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    kind: "approval",
    status: "open",
    priority: "high",
    notify: "needs_you",
    title: "Run `git push --force`",
    body: null,
    projectId: "p1",
    sessionId,
    threadId: "t1",
    itemId: `item-${id}`,
    requestId: `req-${id}`,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    resolvedAt: null,
    resolution: null,
    ...over,
  };
}

/** The inbox question for an MCP server's form, with its transcript item in `transcript`. */
function mcpForm(
  id: string,
  sessionId: string,
  transcript: Map<string, Item>,
  over: Partial<InboxItem> = {},
): InboxItem {
  const item = approval(id, sessionId, {
    kind: "question",
    priority: "normal",
    title: "deploy asks: Where should I deploy?",
    ...over,
  });
  transcript.set(item.itemId as string, {
    id: item.itemId as string,
    kind: "user_question",
    status: "in_progress",
    requestId: item.requestId as string,
    mcpServer: "deploy",
    questions: [
      {
        id: "environment",
        question: "Where?",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  });
  return item;
}

/** A tiny event store, session repo, project list and inbox around the service. */
function harness(
  sessions: Session[],
  mode: Project["autonomyMode"] = "assisted",
  transcript = new Map<string, Item>(),
) {
  const listeners: Array<(events: RawEventEnvelope[]) => void> = [];
  const items = new Map<string, InboxItem>();
  const respond = vi.fn(async (_sessionId: string, req: { requestId: string }) => {
    for (const item of items.values()) {
      if (item.requestId === req.requestId) items.set(item.id, { ...item, status: "resolved" });
    }
  });
  const service = new UnwatchedApprovals({
    store: {
      subscribe: (fn: (events: RawEventEnvelope[]) => void) => {
        listeners.push(fn);
        return () => undefined;
      },
    } as never,
    repo: {
      find: (id: string) => {
        const session = sessions.find((s) => s.id === id);
        return session ? { session } : undefined;
      },
      item: (_sessionId: string, itemId: string) => {
        const item = transcript.get(itemId);
        return item ? { item } : undefined;
      },
    } as never,
    projects: { get: () => ({ id: "p1", autonomyMode: mode }) as Project } as never,
    inbox: {
      list: () => [...items.values()].filter((i) => i.status === "open"),
      find: (id: string) => items.get(id),
    } as never,
    respond,
    waitMs: WAIT,
    now: () => Date.now(),
  });
  const raise = (item: InboxItem) => {
    items.set(item.id, item);
    for (const fn of listeners) {
      fn([
        {
          seq: 1,
          sessionId: item.sessionId,
          ts: item.createdAt,
          type: "inbox.created",
          payload: { item },
        },
      ]);
    }
  };
  return { service, respond, raise, items };
}

const user = { ...sampleSession, id: "s-user", projectId: "p1", role: "agent" as const };
const automation = {
  ...user,
  id: "s-auto",
  automationRunId: "run-1",
  startedBy: { kind: "automation" as const, id: "a1" },
};
const factory = { ...user, id: "s-factory", startedBy: FACTORY_STARTER };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("approvals nobody is watching (§10.1, §11.2)", () => {
  it("tells unwatched sessions apart from the user's own", () => {
    expect(isUnwatched(automation)).toBe(true);
    expect(isUnwatched(factory)).toBe(true);
    expect(isUnwatched({ ...user, startedBy: { kind: "pm", id: "pm-1" } })).toBe(true);
    expect(isUnwatched(user)).toBe(false);
    expect(isUnwatched({ ...user, startedBy: { kind: "orchestrator" } })).toBe(false);
  });

  it("denies a dark factory's approvals at once, with guidance", async () => {
    const h = harness([factory], "dark_factory");
    h.service.start();
    h.raise(approval("a1", factory.id));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.respond).toHaveBeenCalledWith(factory.id, {
      requestId: "req-a1",
      response: {
        kind: "approval",
        decision: "deny",
        message: UNATTENDED_APPROVAL,
        decidedBy: "policy",
      },
    });
    expect(UNATTENDED_APPROVAL).toContain("create_pull_request");
    expect(UNATTENDED_APPROVAL).toContain("factory_record_decision");
  });

  it("gives an automation's approval time for the user, then denies it", async () => {
    const h = harness([automation, factory]);
    h.service.start();
    h.raise(approval("a1", automation.id));
    h.raise(approval("a2", factory.id));
    await vi.advanceTimersByTimeAsync(WAIT - 1_000);
    expect(h.respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(h.respond).toHaveBeenCalledWith(automation.id, {
      requestId: "req-a1",
      response: expect.objectContaining({
        decision: "deny",
        decidedBy: "policy",
        message: noAnswerDenial(WAIT),
      }),
    });
    expect(noAnswerDenial(WAIT)).toMatch(/30 minutes/);
  });

  it("never denies what the user answered, and leaves the user's own sessions waiting", async () => {
    const h = harness([automation, user]);
    h.service.start();
    h.raise(approval("a1", automation.id));
    h.raise(approval("a2", user.id));
    const answered = { ...(h.items.get("a1") as InboxItem), status: "resolved" as const };
    h.items.set("a1", answered);
    await vi.advanceTimersByTimeAsync(WAIT * 10);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("keeps an approval's age across a restart", async () => {
    const h = harness([automation]);
    h.items.set(
      "old",
      approval("old", automation.id, { createdAt: new Date(T0 - WAIT + 60_000).toISOString() }),
    );
    h.service.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.respond).toHaveBeenCalledTimes(1);
    h.service.stop();
  });
});

describe("MCP server forms nobody is watching (§10.1)", () => {
  const cancel = (requestId: string) => ({ requestId, response: { kind: "cancel" } });

  it("withdraws an automation's form after the wait, sending no data", async () => {
    const transcript = new Map<string, Item>();
    const h = harness([automation], "assisted", transcript);
    h.service.start();
    h.raise(mcpForm("f1", automation.id, transcript));
    await vi.advanceTimersByTimeAsync(WAIT - 1_000);
    expect(h.respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledWith(automation.id, cancel("req-f1"));
  });

  it("keeps a form the user answered in time, and the user's own sessions' forms", async () => {
    const transcript = new Map<string, Item>();
    const h = harness([automation, user], "assisted", transcript);
    h.service.start();
    h.raise(mcpForm("f1", automation.id, transcript));
    h.raise(mcpForm("f2", user.id, transcript));
    await vi.advanceTimersByTimeAsync(WAIT - 1_000);
    h.items.set("f1", { ...(h.items.get("f1") as InboxItem), status: "resolved" });
    await vi.advanceTimersByTimeAsync(WAIT * 10);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("withdraws a form that was already overdue when the server restarted", async () => {
    const transcript = new Map<string, Item>();
    const h = harness([automation], "assisted", transcript);
    const old = mcpForm("old", automation.id, transcript, {
      createdAt: new Date(T0 - 2 * WAIT).toISOString(),
    });
    h.items.set(old.id, old);
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.respond).toHaveBeenCalledWith(automation.id, cancel("req-old"));
    h.service.stop();
  });

  it("withdraws a dark factory's form at once", async () => {
    const transcript = new Map<string, Item>();
    const h = harness([factory], "dark_factory", transcript);
    h.service.start();
    h.raise(mcpForm("f1", factory.id, transcript));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.respond).toHaveBeenCalledWith(factory.id, cancel("req-f1"));
  });

  it("leaves the agent's own questions to the factory's rules", async () => {
    const h = harness([automation]);
    h.service.start();
    h.raise(approval("q1", automation.id, { kind: "question" }));
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(h.respond).not.toHaveBeenCalled();
  });
});
