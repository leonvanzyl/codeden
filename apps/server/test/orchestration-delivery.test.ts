import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEventToNewEvent,
  type NewEvent,
  NOTICE_BATCH_CODE,
  type Notice,
  type Session,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { askMarker, PmAsks } from "../src/services/orchestration/asks";
import { NoticeCards } from "../src/services/orchestration/cards";
import { NoticeDelivery } from "../src/services/orchestration/delivery";
import { type NoticeDraft, NoticeStore } from "../src/services/orchestration/notices";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

let dir: string;
let database: Database;
let store: EventStore;
let notices: NoticeStore;
let repo: SessionRepo;

const pm: Session = {
  ...sampleSession,
  id: "pm1",
  role: "pm",
  projectId: "p1",
  status: "idle",
  rootThreadId: "t1",
};
const agent: Session = { ...sampleSession, id: "ag1", projectId: "p1", rootThreadId: "t9" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-delivery-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([
    { type: "session.created", sessionId: pm.id, payload: { session: pm } },
    { type: "session.created", sessionId: agent.id, payload: { session: agent } },
  ]);
  notices = new NoticeStore(database.db, store);
  repo = new SessionRepo(database.db, store);
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const finished = (id: string, over: Partial<NoticeDraft> = {}): NoticeDraft =>
  ({
    id,
    type: "session.finished",
    projectId: "p1",
    target: "pm",
    sessionId: agent.id,
    title: `Finished ${id}`,
    data: {
      sessionId: agent.id,
      workKey: "issue:3",
      purpose: "Fix typo",
      startedBy: { kind: "pm" },
      summary: `Summary of ${id}`,
      outcome: null,
    },
    ...over,
  }) as NoticeDraft;

const pmMessage = (id: string, informational: boolean, over: Partial<NoticeDraft> = {}) =>
  ({
    id,
    type: "pm.message",
    projectId: "p1",
    target: "orchestrator",
    sessionId: pm.id,
    title: "Message from the PM",
    data: { fromSessionId: pm.id, text: `text of ${id}`, informational },
    ...over,
  }) as NoticeDraft;

function delivery(opts: { retryDelaysMs?: number[] } = {}) {
  const request = vi.fn();
  const d = new NoticeDelivery({
    db: database.db,
    notices,
    cards: new NoticeCards(store),
    wakes: { request },
    digestFor: () => "<codeden_status>digest</codeden_status>",
    projectName: () => "Shop",
    session: (id) => repo.find(id)?.session,
    projectIds: () => ["p1", "p2"],
    retryDelaysMs: opts.retryDelaysMs ?? [1_000, 2_000],
  });
  return { d, request };
}

const ids = (list: Notice[]) => list.map((n) => n.id);

describe("notice delivery (§8.2)", () => {
  it("marks notices delivered only once the turn carrying them was sent", () => {
    notices.create(finished("n1"));
    notices.create(finished("n2"));
    const { d } = delivery();

    const first = d.decorate(pm, { text: "wake", attachments: [] });
    expect(first.input.text).toContain("Summary of n1");
    expect(first.input.text).toContain("Summary of n2");
    expect(first.input.text.endsWith("wake")).toBe(true);
    expect(ids(notices.undelivered("pm", "p1"))).toEqual(["n1", "n2"]);
    // A message sent meanwhile doesn't carry them a second time.
    const racing = d.decorate(pm, { text: "hello", attachments: [] });
    expect(racing.input.text).not.toContain("Summary of n1");

    // The send failed: they wait for the next turn.
    first.failed?.(new Error("refused"));
    expect(ids(notices.undelivered("pm", "p1"))).toEqual(["n1", "n2"]);
    const retry = d.decorate(pm, { text: "wake", attachments: [] });
    expect(retry.input.text).toContain("Summary of n1");
    retry.delivered?.();
    expect(notices.undelivered("pm", "p1")).toEqual([]);
  });

  it("re-arms wakes on start for notices that should wake their target", () => {
    notices.create({ ...finished("n1"), wake: true });
    notices.create({ ...finished("n2", { projectId: "p2" }), wake: false });
    notices.create(pmMessage("m1", true));
    const { d, request } = delivery();
    d.rearm();
    expect(request.mock.calls).toEqual([["pm:p1"]]);

    notices.create(pmMessage("m2", false));
    d.rearm();
    expect(request.mock.calls.slice(1)).toEqual([["orchestrator"], ["pm:p1"]]);
  });

  it("returns a failed turn's notices and wakes the role session again, a few times at most", async () => {
    vi.useFakeTimers();
    notices.create(finished("n1"));
    const { d, request } = delivery({ retryDelaysMs: [1_000, 2_000] });
    const turn = (turnId: string, end: "turn.failed" | "turn.completed") => {
      const carried = d.decorate(pm, { text: "wake", attachments: [] });
      carried.delivered?.();
      const notice = notices.list({ projectId: "p1" }).filter((n) => n.id === "n1");
      const appended = store.append([
        ev(pm.id, { type: "turn.started", threadId: "t1", turnId }),
        ev(pm.id, {
          type: "item.completed",
          threadId: "t1",
          turnId,
          item: {
            id: `notices-${turnId}`,
            kind: "notice",
            status: "completed",
            level: "info",
            code: NOTICE_BATCH_CODE,
            message: "1 update since the last turn",
            data: JSON.parse(JSON.stringify({ notices: notice })),
          },
        }),
        end === "turn.failed"
          ? ev(pm.id, {
              type: "turn.failed",
              threadId: "t1",
              turnId,
              error: { message: "Overloaded" },
            })
          : ev(pm.id, { type: "turn.completed", threadId: "t1", turnId }),
      ]);
      d.onEvents(appended);
    };

    turn("u1", "turn.failed");
    expect(ids(notices.undelivered("pm", "p1"))).toEqual(["n1"]);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls).toEqual([["pm:p1"]]);

    turn("u2", "turn.failed");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(2);

    // Out of retries: the notices wait for the next message or notice.
    turn("u3", "turn.failed");
    expect(ids(notices.undelivered("pm", "p1"))).toEqual(["n1"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);

    // A turn that completes starts the count again.
    turn("u4", "turn.completed");
    expect(notices.undelivered("pm", "p1")).toEqual([]);
    notices.create(finished("n2"));
    turn("u5", "turn.failed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
  });
});

function ev(sessionId: string, e: Parameters<typeof agentEventToNewEvent>[1]): NewEvent {
  return agentEventToNewEvent(sessionId, e);
}

describe("ask_pm answers that outlive the call (§8.3)", () => {
  /** A turn of `session` that starts with `text` and ends with `reply`. */
  const answeredTurn = (session: Session, turnId: string, text: string, reply: string) =>
    store.append([
      ev(session.id, { type: "turn.started", threadId: session.rootThreadId ?? "t1", turnId }),
      ev(session.id, {
        type: "item.completed",
        threadId: session.rootThreadId ?? "t1",
        turnId,
        item: {
          id: `in-${turnId}`,
          kind: "user_message",
          status: "completed",
          input: { text, attachments: [] },
        },
      }),
      ev(session.id, {
        type: "item.completed",
        threadId: session.rootThreadId ?? "t1",
        turnId,
        item: { id: `out-${turnId}`, kind: "assistant_message", status: "completed", text: reply },
      }),
      ev(session.id, { type: "turn.completed", threadId: session.rootThreadId ?? "t1", turnId }),
    ]);

  const asks = () => {
    const onLateReply = vi.fn();
    const a = new PmAsks({
      db: database.db,
      session: (id) => repo.find(id)?.session,
      onLateReply,
    });
    return { a, onLateReply };
  };

  it("sends the answer to an ask nobody tracks any more (a restart) to the orchestrator", async () => {
    const { a, onLateReply } = asks();
    const events = answeredTurn(
      pm,
      "u1",
      `<codeden_status>…</codeden_status>\n\nQuestion from the orchestrator ${askMarker("abcd1234")}:\nRun an audit`,
      "Started the audit as session 42.",
    );
    a.onEvents(events);
    await new Promise((r) => setImmediate(r));
    expect(onLateReply).toHaveBeenCalledWith({
      askId: "abcd1234",
      projectId: "p1",
      pmSessionId: pm.id,
      text: "Started the audit as session 42.",
    });
  });

  it("answers a waiting call once, and ignores markers in other sessions", async () => {
    const { a, onLateReply } = asks();
    a.register("feed1234", { pmSessionId: pm.id, projectId: "p1", fromSessionId: null });
    const answer = a.wait("feed1234", 5_000);
    a.onEvents(answeredTurn(pm, "u1", `Question ${askMarker("feed1234")}: status?`, "All quiet."));
    expect(await answer).toEqual({ status: "answered", text: "All quiet." });
    a.onEvents(answeredTurn(agent, "u2", `Quoted ${askMarker("beef1234")}`, "Not a PM."));
    await new Promise((r) => setImmediate(r));
    expect(onLateReply).not.toHaveBeenCalled();
  });
});
