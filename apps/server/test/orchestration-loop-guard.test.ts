import type { MessageSender, Notice, Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldNote } from "../src/mcp/tools/orchestrator/messaging";
import { LoopGuard } from "../src/services/orchestration/loop-guard";
import type { NoticeDraft } from "../src/services/orchestration/notices";
import { type WakeResult, WakeScheduler } from "../src/services/orchestration/wake-scheduler";
import { sampleSession } from "./helpers";

describe("loop guard (§8.2): only agent-to-agent loops are paced", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  const opts = { debounceMs: 5_000, maxWaitMs: 30_000, maxWakes: 2, windowMs: 60_000 };
  const orchestrator: Session = { ...sampleSession, id: "orch", role: "orchestrator" };
  const pm: Session = { ...sampleSession, id: "pm1", role: "pm", projectId: "p1" };
  const fromOrchestrator = { caller: "mcp" as const, sessionId: "orch" };

  const setup = () => {
    const stored: Notice[] = [];
    const delivered: string[][] = [];
    const wakes = new WakeScheduler(async () => "sent", opts);
    const guard = new LoopGuard({
      wakes,
      notices: {
        create: (draft: NoticeDraft) => {
          const notice = { ...draft, createdAt: "t", deliveredAt: null } as Notice;
          stored.push(notice);
          return notice;
        },
        undelivered: () => stored.filter((n) => !n.deliveredAt),
      },
      // The PM's wake delivers every undelivered notice.
      wakePm: async (): Promise<WakeResult> => {
        const batch = stored.filter((n) => !n.deliveredAt);
        for (const n of batch) n.deliveredAt = "t";
        delivered.push(batch.map((n) => (n.type === "orchestrator.message" ? n.data.text : "")));
        return "sent";
      },
      options: opts,
    });
    const turn = (session: Session, from: MessageSender) => guard.turnStarted(session, from);
    return { guard, wakes, stored, delivered, turn };
  };

  it("lets the user's request through to a PM woken over and over by its sessions", async () => {
    const { guard, wakes, turn } = setup();
    // Two of the PM's sessions report: the PM's notice wakes reach their limit.
    for (let i = 0; i < 2; i += 1) {
      wakes.request("pm:p1");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(wakes.allowed("pm:p1")).toBe(false);
    // Session reports are not orchestrator messages: even an automatic one goes through.
    turn(orchestrator, "codeden");
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(true);
    // The user asks the orchestrator: its message goes through and clears the PM's counts.
    turn(orchestrator, "user");
    expect(guard.humanLed(fromOrchestrator)).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(true);
    expect(wakes.allowed("pm:p1")).toBe(true);
    // A tool call made through the UI is the user's own as well.
    expect(guard.humanLed({ caller: "ui", sessionId: null })).toBe(true);
    expect(guard.humanLed({ caller: "mcp", sessionId: null })).toBe(false);
  });

  it("knows which PM turns carry the user's request, relayed ones included (#137)", () => {
    const { guard } = setup();
    const fromPm = { caller: "mcp" as const, sessionId: "pm1" };
    for (const from of ["automation", "codeden", "factory", "orchestrator"] as const) {
      guard.turnStarted(pm, from);
      expect(guard.humanLed(fromPm)).toBe(false);
    }
    guard.turnStarted(pm, "user");
    expect(guard.humanLed(fromPm)).toBe(true);
    // The orchestrator passes on what the user asked it: the PM's turn is the user's too.
    guard.turnStarted(pm, "orchestrator", { relayedForUser: true });
    expect(guard.humanLed(fromPm)).toBe(true);
    // The next turn decides afresh; only the orchestrator can relay for the user.
    guard.turnStarted(pm, "codeden", { relayedForUser: true });
    expect(guard.humanLed(fromPm)).toBe(false);
  });

  it("gives a turn the origin of the delivery the runner accepted, never a rejected one (#137)", () => {
    const saved = new Map<string, boolean>();
    const guard = new LoopGuard({
      wakes: new WakeScheduler(async () => "sent", opts),
      notices: { create: () => undefined, undelivered: () => [] },
      wakePm: async () => "empty",
      turnOrigins: {
        load: (id) => saved.get(id),
        save: (id, fromUser) => saved.set(id, fromUser),
      },
      options: opts,
    });
    const fromPm = { caller: "mcp" as const, sessionId: "pm1" };

    // An automation's turn is running; the user's message to it is rejected by the runner.
    guard.turnStarted(pm, "automation");
    const rejected = guard.beginTurn(pm, "user");
    expect(guard.humanLed(fromPm)).toBe(false);
    rejected.failed();
    expect(guard.humanLed(fromPm)).toBe(false);
    // Nothing saved says it's the user's (an origin never saved counts as not the user's).
    expect(saved.get("pm1")).not.toBe(true);

    // The user's turn is accepted. A later automatic message has no authority while in flight;
    // once the runner turns it down, the user's running turn has its origin back.
    const user = guard.beginTurn(pm, "user");
    expect(guard.humanLed(fromPm)).toBe(false);
    user.accepted();
    expect(guard.humanLed(fromPm)).toBe(true);
    const wake = guard.beginTurn(pm, "codeden");
    expect(guard.humanLed(fromPm)).toBe(false);
    expect(saved.get("pm1")).toBe(false);
    wake.failed();
    expect(guard.humanLed(fromPm)).toBe(true);
    expect(saved.get("pm1")).toBe(true);
    // Accepted, the automatic turn is automatic.
    guard.beginTurn(pm, "codeden").accepted();
    expect(guard.humanLed(fromPm)).toBe(false);
    expect(saved.get("pm1")).toBe(false);
  });

  it("keeps a turn's origin across a server restart, and refuses unknown ones (#137)", () => {
    // What the session rows keep: the guard of a restarted server starts with empty memory.
    const saved = new Map<string, boolean>();
    const turnOrigins = {
      load: (id: string) => saved.get(id),
      save: (id: string, fromUser: boolean) => saved.set(id, fromUser),
    };
    const restarted = () =>
      new LoopGuard({
        wakes: new WakeScheduler(async () => "sent", opts),
        notices: { create: () => undefined, undelivered: () => [] },
        wakePm: async () => "empty",
        turnOrigins,
        options: opts,
      });
    const fromPm = { caller: "mcp" as const, sessionId: "pm1" };
    const fromOrchestrator = { caller: "mcp" as const, sessionId: "orch" };

    // Never recorded (a turn from before the origin was saved): not the user's.
    expect(restarted().humanLed(fromPm)).toBe(false);
    const before = restarted();
    before.turnStarted(pm, "user");
    before.turnStarted(orchestrator, "user");
    // The runner keeps both turns going while the server restarts.
    const after = restarted();
    expect(after.humanLed(fromPm)).toBe(true);
    expect(after.humanLed(fromOrchestrator)).toBe(true);

    // Automated turns stay automated after a restart too.
    after.turnStarted(pm, "automation");
    after.turnStarted(orchestrator, "codeden");
    const again = restarted();
    expect(again.humanLed(fromPm)).toBe(false);
    expect(again.humanLed(fromOrchestrator)).toBe(false);
    again.turnStarted(pm, "orchestrator", { relayedForUser: true });
    expect(restarted().humanLed(fromPm)).toBe(true);
  });

  it("holds an orchestrator <-> PM ping-pong back and delivers it once the window allows", async () => {
    const { guard, stored, delivered, turn } = setup();
    turn(orchestrator, "codeden"); // woken by a PM message: no person in this turn
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(true);
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(false);
    const until = guard.hold("p1", "orch", "third");
    expect(until).toBe(60_000); // the first message leaves the window
    // A later message waits behind the held one rather than overtaking it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(false);
    guard.hold("p1", "orch", "fourth");
    expect(stored.map((n) => n.type)).toEqual(["orchestrator.message", "orchestrator.message"]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(delivered).toEqual([["third", "fourth"]]);
    expect(guard.relays.isPending("pm:p1")).toBe(false);
  });

  it("releases held messages as soon as the user writes to the PM", async () => {
    const { guard, delivered, turn } = setup();
    turn(orchestrator, "codeden");
    guard.mayDeliver("p1", fromOrchestrator);
    guard.mayDeliver("p1", fromOrchestrator);
    expect(guard.mayDeliver("p1", fromOrchestrator)).toBe(false);
    guard.hold("p1", "orch", "held");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual([]);
    turn(pm, "user");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual([["held"]]);
    expect(guard.relays.allowed("pm:p1")).toBe(true);
  });

  it("tells the orchestrator a held message is queued, with nothing to retry or ask", () => {
    const soon = heldNote("codeden", 30_000, 0);
    expect(soon).toContain("Queued: CodeDen delivers this to the PM of codeden automatically");
    expect(soon).toContain("within a minute");
    const later = heldNote("codeden", 5 * 60_000, 0);
    expect(later).toMatch(/at about \d\d:\d\d \(local time\)/);
    for (const text of [soon, later]) {
      expect(text).toContain("do not send it again");
      expect(text).not.toMatch(/ask the user|wait a few minutes|try again|retry later/i);
    }
  });
});
