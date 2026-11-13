import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentEvent, RunnerEvent } from "@codeden/contracts";
import {
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  type ProviderSession,
} from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaBatcher } from "../src/delta-batcher";
import { Journal } from "../src/journal";
import { SessionHost } from "../src/session-host";

/**
 * Bytes the runner writes to disk, and its temp-file renames (one per whole-file rewrite):
 * which file, at what (fake) time.
 */
const io = vi.hoisted(() => ({ bytes: 0, renames: [] as { file: string; at: number }[] }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const size = (data: unknown) =>
    typeof data === "string"
      ? Buffer.byteLength(data)
      : ArrayBuffer.isView(data)
        ? data.byteLength
        : 0;
  return {
    ...fs,
    appendFileSync: ((file, data, options) => {
      io.bytes += size(data);
      return fs.appendFileSync(file, data, options);
    }) as typeof fs.appendFileSync,
    writeFileSync: ((file, data, options) => {
      io.bytes += size(data);
      return fs.writeFileSync(file, data, options);
    }) as typeof fs.writeFileSync,
    writeSync: ((fd: number, data: unknown, ...rest: unknown[]) => {
      io.bytes += size(data);
      return (fs.writeSync as (...args: unknown[]) => number)(fd, data, ...rest);
    }) as typeof fs.writeSync,
    renameSync: ((from, to) => {
      io.renames.push({ file: basename(String(to)), at: Date.now() });
      return fs.renameSync(from, to);
    }) as typeof fs.renameSync,
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-journal-cost-"));
  resetIo();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function resetIo(): void {
  io.bytes = 0;
  io.renames = [];
}

const THREAD = "t-root";
const TURN = "turn-1";
const ITEM = "msg-1";

/** A provider whose one session streams `tokens` as one-token text deltas, back to back. */
function streamingProvider(tokens: string[]): ProviderAdapter {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: "thread.started", thread: { id: THREAD } };
    yield { type: "turn.started", threadId: THREAD, turnId: TURN };
    const item = { id: ITEM, kind: "assistant_message" as const, text: "" };
    yield {
      type: "item.started",
      threadId: THREAD,
      turnId: TURN,
      item: { ...item, status: "in_progress" },
    };
    for (const text of tokens) {
      yield {
        type: "item.delta",
        threadId: THREAD,
        turnId: TURN,
        itemId: ITEM,
        delta: { type: "text", text },
      };
    }
    const done = { ...item, text: tokens.join(""), status: "completed" as const };
    yield { type: "item.completed", threadId: THREAD, turnId: TURN, item: done };
    yield { type: "turn.completed", threadId: THREAD, turnId: TURN };
  }
  const session: ProviderSession = {
    events: events(),
    send: async () => {},
    interrupt: async () => {},
    respond: async () => {},
    close: async () => {},
    resumeToken: () => "streaming-1",
  };
  return {
    id: "streaming",
    displayName: "Streaming",
    detect: () => new FakeProvider().detect(),
    capabilities: () => new FakeProvider().capabilities(),
    models: () => [],
    openSession: async () => session,
  };
}

describe("streamed tokens", () => {
  it("are journaled as a few batched deltas, not one durable event per token", async () => {
    const tokens = Array.from({ length: 1000 }, (_, i) => `w${i} `);
    const journaled: RunnerEvent[] = [];
    let exited: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      exited = resolve;
    });
    // Wired like the runner: the session host emits into the batcher, which journals.
    const deltas = new DeltaBatcher((event) => {
      journaled.push(event);
      if (event.kind === "session.process" && event.state === "exited") exited();
    });
    const registry = new ProviderRegistry([streamingProvider(tokens)]);
    const host = new SessionHost(registry, (event) => deltas.push(event));
    await host.start({
      name: "session.start",
      sessionId: "s1",
      providerId: "streaming",
      checkpoints: false,
      options: {
        sessionId: "s1",
        role: "agent",
        cwd: home,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      },
    });
    await ended;

    const agent = journaled.flatMap((e) => (e.kind === "agent" ? [e.event] : []));
    const items = agent.flatMap((e) => (e.type === "item.delta" ? [e] : []));
    // Nothing is lost or reordered: the deltas still add up to the message, before it completes.
    expect(items.map((d) => (d.delta.type === "text" ? d.delta.text : "")).join("")).toBe(
      tokens.join(""),
    );
    const types = agent.map((e) => e.type);
    expect(types.lastIndexOf("item.delta")).toBeLessThan(types.indexOf("item.completed"));
    // Every journaled event is also a WebSocket send, a server transaction and an ack.
    expect(items.length).toBeLessThanOrEqual(10);
  });
});

describe("Journal acks", () => {
  // The journal persists on a timer: fake, so time is exact and no timer outlives its test.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("do not rewrite the journal and its state on every ack", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir);
    const count = 2000;
    for (let i = 0; i < count; i++) journal.append(textDelta(`token ${i} `));
    const appended = io.bytes;
    resetIo();

    // The server acks each event as soon as it has stored it: here one per millisecond.
    for (let seq = 1; seq <= count / 2; seq++) ackAndWait(journal, seq, 1);
    const reloaded = new Journal(dir);
    expect(reloaded.after(count / 2).map((e) => e.seq)).toEqual(seqs(count / 2 + 1, count));
    for (let seq = count / 2 + 1; seq <= count; seq++) ackAndWait(journal, seq, 1);

    // Acking costs about as much as appending did, not a full rewrite of what is left per ack.
    expect(io.renames.length).toBeLessThan(count / 100);
    expect(io.bytes).toBeLessThan(appended * 2);

    journal.close();
    expect(new Journal(dir).after(0)).toEqual([]);
    expect(new Journal(dir).append(draining("x")).seq).toBe(count + 1);
  });

  it("write nothing on ack, and drop acked events once enough pile up", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir, { compactEntries: 4 });
    for (let i = 0; i < 6; i++) journal.append(draining(`r${i}`));
    resetIo();

    journal.ack(1);
    journal.ack(3);
    journal.ack(4);
    expect(io).toEqual({ bytes: 0, renames: [] });
    expect(lines(dir)).toHaveLength(6);
    // At the next persist: four acked events, and rewriting the two left costs less.
    vi.advanceTimersByTime(250);
    expect(io.renames.map((r) => r.file)).toEqual(["state.json", "journal.jsonl"]);
    expect(lines(dir).map((l) => l.seq)).toEqual([5, 6]);
    expect(journal.after(0).map((e) => e.seq)).toEqual([5, 6]);
    expect(stateOf(dir)).toMatchObject({ lastSeq: 6, ackedSeq: 4 });

    // Below the threshold only the state is written; close drops what is acked.
    ackAndWait(journal, 6, 250);
    expect(lines(dir)).toHaveLength(2);
    expect(stateOf(dir)).toMatchObject({ ackedSeq: 6 });
    journal.close();
    expect(lines(dir)).toEqual([]);
    expect(new Journal(dir).append(draining("next")).seq).toBe(7);

    // Acked events that are fewer than what is left stay until they outweigh it.
    const other = join(home, "other");
    const big = new Journal(other, { compactEntries: 2 });
    for (let i = 0; i < 10; i++) big.append(draining(`r${i}`));
    ackAndWait(big, 4, 250);
    expect(lines(other)).toHaveLength(10);
    ackAndWait(big, 6, 250);
    expect(lines(other)).toHaveLength(4);
    // Everything acked: the file empties, and the seq carries on after a restart (no close).
    ackAndWait(big, 10, 250);
    expect(lines(other)).toEqual([]);
    expect(new Journal(other).append(draining("next")).seq).toBe(11);
  });

  it("persist at most every 250 ms while acks flow, however many thresholds they cross", () => {
    // An ack every 5 ms for a second; both thresholds are crossed every 50 ms or so.
    const byEntries = new Journal(join(home, "entries"), { compactEntries: 10 });
    const byBytes = new Journal(join(home, "bytes"), { compactBytes: 1000 });
    for (const journal of [byEntries, byBytes]) {
      for (let i = 0; i < 200; i++) journal.append(draining("r"));
      resetIo();
      const from = Date.now();
      for (let seq = 1; seq <= 200; seq++) ackAndWait(journal, seq, 5);

      const states = io.renames.filter((r) => r.file === "state.json");
      expect(states.length).toBeGreaterThanOrEqual(3);
      expect(states.length).toBeLessThanOrEqual((Date.now() - from) / 250);
      for (let i = 1; i < states.length; i++) {
        expect((states[i]?.at ?? 0) - (states[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(250);
      }
      // Compaction happens, only with a persist, and only after that persist's state write.
      const compactions = io.renames.flatMap((r, i) =>
        r.file === "journal.jsonl" ? [{ ...r, before: io.renames[i - 1] }] : [],
      );
      expect(compactions.length).toBeGreaterThanOrEqual(1);
      for (const c of compactions) expect(c.before).toEqual({ file: "state.json", at: c.at });
    }
  });

  it("write the acked position at most every 250 ms while acks flow, and on close", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir);
    for (let i = 0; i < 5; i++) journal.append(draining(`r${i}`));
    resetIo();

    journal.ack(1);
    journal.ack(2);
    vi.advanceTimersByTime(249);
    expect(io.renames).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(io.renames.map((r) => r.file)).toEqual(["state.json"]);
    expect(stateOf(dir)).toMatchObject({ ackedSeq: 2 });
    expect(lines(dir)).toHaveLength(5);

    journal.ack(3);
    journal.close();
    expect(stateOf(dir)).toMatchObject({ lastSeq: 5, ackedSeq: 3 });
    expect(lines(dir).map((l) => l.seq)).toEqual([4, 5]);
    vi.runAllTimers(); // close cancelled the pending persist
    expect(io.renames.map((r) => r.file)).toEqual(["state.json", "state.json", "journal.jsonl"]);
  });

  it("recover from a torn last line left by a crash mid-append", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir, { compactEntries: 10 });
    for (let i = 0; i < 30; i++) journal.append(draining(`r${i}`));
    for (let seq = 1; seq <= 30; seq++) ackAndWait(journal, seq, 10); // compacts along the way
    for (let i = 30; i < 35; i++) journal.append(draining(`r${i}`));
    journal.ack(32);
    // Killed while appending seq 36: no close, the acked position on disk is behind and the
    // last line is cut short.
    appendFileSync(join(dir, "journal.jsonl"), '{"type":"event","seq":36,"ts":"20');

    const restarted = new Journal(dir, { compactEntries: 10 });
    expect(restarted.lastSeq).toBe(35);
    // The server resumes from the last seq it stored; seq 36 never reached it.
    restarted.ack(32);
    expect(restarted.after(32).map((e) => e.seq)).toEqual([33, 34, 35]);
    expect(restarted.append(draining("after restart")).seq).toBe(36);

    const again = new Journal(dir);
    again.ack(32);
    expect(again.after(32).map((e) => e.seq)).toEqual([33, 34, 35, 36]);
    expect(again.after(35)[0]?.event).toEqual(draining("after restart"));
  });
});

function ackAndWait(journal: Journal, seq: number, ms: number): void {
  journal.ack(seq);
  vi.advanceTimersByTime(ms);
}

function textDelta(text: string): RunnerEvent {
  return {
    kind: "agent",
    sessionId: "s1",
    event: {
      type: "item.delta",
      threadId: THREAD,
      turnId: TURN,
      itemId: ITEM,
      delta: { type: "text", text },
    },
  };
}

function draining(reason: string): RunnerEvent {
  return { kind: "runner.draining", reason };
}

function seqs(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function lines(dir: string): { seq: number }[] {
  const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq: number });
}

function stateOf(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}
