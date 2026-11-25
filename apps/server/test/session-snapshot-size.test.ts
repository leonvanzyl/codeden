import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEventToNewEvent, type NewEvent, SessionSnapshot } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { sampleSessionEvent } from "./helpers";
import { removeTree } from "./support/remove-tree";

const TOKEN = "t".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };
let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-snapshot-size-"));
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

const a = (e: Parameters<typeof agentEventToNewEvent>[1]) => agentEventToNewEvent("s1", e);

/** Session s1 with root thread t1 and no turns yet. */
function seedSession() {
  const [created, thread] = sampleSessionEvent();
  server.store.append([created as NewEvent, thread as NewEvent]);
}

/** Root turn `u<n>`: a message and a reply (`in-<n>`, `out-<n>`). */
function rootTurn(n: number, reply = `Reply ${n}`) {
  const turnId = `u${n}`;
  server.store.append([
    a({ type: "turn.started", threadId: "t1", turnId }),
    a({
      type: "item.completed",
      threadId: "t1",
      turnId,
      item: {
        id: `in-${n}`,
        kind: "user_message",
        status: "completed",
        input: { text: `Message ${n}`, attachments: [] },
      },
    }),
    a({
      type: "item.completed",
      threadId: "t1",
      turnId,
      item: { id: `out-${n}`, kind: "assistant_message", status: "completed", text: reply },
    }),
    a({ type: "turn.completed", threadId: "t1", turnId }),
  ]);
}

/** Root turn `u<n>` that runs a subagent (card `sub-<n>`, thread `c<n>`, its item `c<n>-msg`). */
function subagentTurn(n: number) {
  const turnId = `u${n}`;
  const child = `c${n}`;
  const card = {
    id: `sub-${n}`,
    kind: "subagent" as const,
    childThreadId: child,
    agentType: "reviewer",
  };
  server.store.append([
    a({ type: "turn.started", threadId: "t1", turnId }),
    a({
      type: "thread.started",
      thread: { id: child, parentThreadId: "t1", parentItemId: card.id, agentType: "reviewer" },
    }),
    a({ type: "item.started", threadId: "t1", turnId, item: { ...card, status: "in_progress" } }),
    a({ type: "turn.started", threadId: child, turnId: `${child}-turn` }),
    a({
      type: "item.completed",
      threadId: child,
      turnId: `${child}-turn`,
      item: { id: `${child}-msg`, kind: "assistant_message", status: "completed", text: "Done" },
    }),
    a({ type: "turn.completed", threadId: child, turnId: `${child}-turn` }),
    a({ type: "item.completed", threadId: "t1", turnId, item: { ...card, status: "completed" } }),
    a({ type: "turn.completed", threadId: "t1", turnId }),
  ]);
}

async function snapshot(query = "") {
  const res = await fetch(`${server.url}/api/sessions/s1/snapshot${query}`, { headers: auth });
  const body = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(body), body: JSON.parse(body) as unknown };
}

const parse = (v: unknown) => SessionSnapshot.parse(v);
const itemIds = (snap: SessionSnapshot) => snap.items.map((r) => r.item.id);
/** Turn ids, sorted: a root turn and its subagent's can start in the same millisecond. */
const turnIds = (snap: SessionSnapshot) => snap.turns.map((t) => t.id).sort();

describe("opening a long-lived session (#321)", () => {
  it("loads a page of the latest transcript, not every item the session ever had", async () => {
    seedSession();
    const turns = 1_000;
    for (let n = 0; n < turns; n++) rootTurn(n, "x".repeat(1_000));
    // What the transcript view asks for: the latest turns.
    const page = await snapshot("?turns=20");
    expect(page.status).toBe(200);
    const snap = parse(page.body);
    // The latest turn is there to show...
    expect(snap.items.some((r) => r.item.id === `out-${turns - 1}`)).toBe(true);
    // ...but the response is bounded: a page, not the whole history, so it stops growing with
    // every turn, and it says how much is left before it.
    expect.soft(snap.items.length).toBeLessThanOrEqual(500);
    expect.soft(page.bytes).toBeLessThan(1_000_000);
    expect(snap.earlierTurns).toBe(turns - 20);
    const link = await snapshot("?turns=20&item=out-0");
    const focused = parse(link.body);
    expect(focused.turns).toEqual(snap.turns);
    expect(focused.focused?.turns.map((t) => t.id)).toEqual(["u0"]);
    expect(focused.focused?.items.map((item) => item.item.id)).toContain("out-0");
    expect(link.bytes).toBeLessThan(page.bytes + 8_000);
    // The whole-session form stays available.
    const whole = parse((await snapshot()).body);
    expect(whole.items).toHaveLength(2 * turns);
    expect(whole.earlierTurns).toBe(0);
  });
});

describe("session snapshot by root turns", () => {
  it("returns the latest turns with their items and the subagent threads they started", async () => {
    seedSession();
    for (let n = 0; n < 6; n++) (n === 1 || n === 4 ? subagentTurn : rootTurn)(n);
    const snap = parse((await snapshot("?turns=2")).body);
    expect(snap.earlierTurns).toBe(4);
    expect(turnIds(snap)).toEqual(["c4-turn", "u4", "u5"]);
    expect(snap.threads.map((t) => t.id).sort()).toEqual(["c4", "t1"]);
    expect(itemIds(snap)).toEqual(["c4-msg", "sub-4", "in-5", "out-5"]);
    // A page larger than the session is the whole thread.
    const all = parse((await snapshot("?turns=50")).body);
    expect(all.earlierTurns).toBe(0);
    expect(all.threads.map((t) => t.id).sort()).toEqual(["c1", "c4", "t1"]);
    expect(all.items).toHaveLength(parse((await snapshot()).body).items.length);
  });

  it("pages back with before, down to the first turn", async () => {
    seedSession();
    for (let n = 0; n < 6; n++) (n === 1 ? subagentTurn : rootTurn)(n);
    const earlier = parse((await snapshot("?turns=2&before=u4")).body);
    expect(turnIds(earlier)).toEqual(["u2", "u3"]);
    expect(itemIds(earlier)).toEqual(["in-2", "out-2", "in-3", "out-3"]);
    expect(earlier.earlierTurns).toBe(2);
    const first = parse((await snapshot("?turns=2&before=u2")).body);
    expect(turnIds(first)).toEqual(["c1-turn", "u0", "u1"]);
    expect(first.threads.map((t) => t.id).sort()).toEqual(["c1", "t1"]);
    expect(first.earlierTurns).toBe(0);
    const missing = await snapshot("?turns=2&before=nope");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "turn_not_found" } });
  });

  it("pages tied start timestamps in insertion order without a gap or duplicate", async () => {
    seedSession();
    for (const id of [9, 2, 12, 1, 4]) rootTurn(id);
    server.database.client.exec("UPDATE turns SET started_at = '2026-11-21T12:00:00.000Z'");
    const latest = parse((await snapshot("?turns=2")).body);
    const earlier = parse((await snapshot("?turns=2&before=u1")).body);
    const first = parse((await snapshot("?turns=2&before=u2")).body);
    expect(latest.turns.map((t) => t.id)).toEqual(["u1", "u4"]);
    expect(earlier.turns.map((t) => t.id)).toEqual(["u2", "u12"]);
    expect(first.turns.map((t) => t.id)).toEqual(["u9"]);
    expect([latest.earlierTurns, earlier.earlierTurns, first.earlierTurns]).toEqual([3, 1, 0]);
  });

  it("returns the latest page and only the owning root turn for an older item", async () => {
    seedSession();
    for (let n = 0; n < 8; n++) (n === 2 ? subagentTurn : rootTurn)(n);
    const hit = parse((await snapshot("?turns=3&item=out-4")).body);
    expect(hit.turns.map((t) => t.id)).toEqual(["u5", "u6", "u7"]);
    expect(hit.earlierTurns).toBe(5);
    expect(hit.focused?.turns.map((t) => t.id)).toEqual(["u4"]);
    expect(hit.focused?.items.map((item) => item.item.id)).toContain("out-4");
    const nested = parse((await snapshot("?turns=3&item=c2-msg")).body);
    expect(nested.earlierTurns).toBe(5);
    expect(nested.focused?.items.map((item) => item.item.id)).toContain("c2-msg");
    expect(nested.focused?.turns.map((t) => t.id).sort()).toEqual(["c2-turn", "u2"]);
    // An item that is already in the latest turns, or doesn't exist, changes nothing.
    expect(parse((await snapshot("?turns=3&item=out-7")).body).earlierTurns).toBe(5);
    expect(parse((await snapshot("?turns=3&item=nope")).body).earlierTurns).toBe(5);
    expect(parse((await snapshot("?turns=3&item=out-7")).body).focused).toBeUndefined();
    expect(parse((await snapshot("?turns=3&item=nope")).body).focused).toBeUndefined();
  });

  it("rejects a query it can't answer", async () => {
    seedSession();
    rootTurn(0);
    expect((await snapshot("?turns=0")).status).toBe(400);
    expect((await snapshot("?before=u0")).status).toBe(400);
    expect((await snapshot("?turns=2&before=u0&item=out-0")).status).toBe(400);
    const empty = parse((await snapshot("?turns=5")).body);
    expect(turnIds(empty)).toEqual(["u0"]);
  });
});
