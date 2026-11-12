import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerEvent } from "@codeden/contracts";
import {
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  type ProviderSession,
} from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../src/journal";
import { SessionHost } from "../src/session-host";

/** Bytes the runner writes to disk and temp-file renames (one per whole-file rewrite). */
const io = vi.hoisted(() => ({ bytes: 0, renames: 0 }));

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
      io.renames += 1;
      return fs.renameSync(from, to);
    }) as typeof fs.renameSync,
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-journal-cost-"));
  io.bytes = 0;
  io.renames = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

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
    const emitted: RunnerEvent[] = [];
    let exited: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const host = new SessionHost(new ProviderRegistry([streamingProvider(tokens)]), (event) => {
      emitted.push(event);
      if (event.kind === "session.process" && event.state === "exited") exited();
    });
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

    const agent = emitted.flatMap((e) => (e.kind === "agent" ? [e.event] : []));
    const deltas = agent.flatMap((e) => (e.type === "item.delta" ? [e] : []));
    // Nothing is lost or reordered: the deltas still add up to the message, before it completes.
    expect(deltas.map((d) => (d.delta.type === "text" ? d.delta.text : "")).join("")).toBe(
      tokens.join(""),
    );
    const types = agent.map((e) => e.type);
    expect(types.lastIndexOf("item.delta")).toBeLessThan(types.indexOf("item.completed"));
    // Every emitted event is a journal append, a WebSocket send, a server transaction and an ack.
    expect(deltas.length).toBeLessThanOrEqual(10);
  });
});

describe("Journal acks", () => {
  // The acked position is written on a timer: fake, so none outlives its test.
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
    for (let i = 0; i < count; i++) {
      journal.append({
        kind: "agent",
        sessionId: "s1",
        event: {
          type: "item.delta",
          threadId: THREAD,
          turnId: TURN,
          itemId: ITEM,
          delta: { type: "text", text: `token ${i} ` },
        },
      });
    }
    const appended = io.bytes;
    io.bytes = 0;
    io.renames = 0;

    // The server acks each event as soon as it has stored it.
    for (let seq = 1; seq <= count / 2; seq++) journal.ack(seq);
    const reloaded = new Journal(dir);
    expect(reloaded.after(count / 2).map((e) => e.seq)).toEqual(seqs(count / 2 + 1, count));
    for (let seq = count / 2 + 1; seq <= count; seq++) journal.ack(seq);

    // Acking costs about as much as appending did, not a full rewrite of what is left per ack.
    expect(io.renames).toBeLessThan(count / 100);
    expect(io.bytes).toBeLessThan(appended * 2);

    journal.close();
    expect(new Journal(dir).after(0)).toEqual([]);
    expect(new Journal(dir).append(draining("x")).seq).toBe(count + 1);
  });

  it("write nothing until enough acked events pile up, then compact them away", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir, { compactEntries: 4 });
    for (let i = 0; i < 6; i++) journal.append(draining(`r${i}`));
    io.bytes = 0;
    io.renames = 0;

    journal.ack(1);
    journal.ack(3);
    expect(io).toEqual({ bytes: 0, renames: 0 });
    expect(lines(dir)).toHaveLength(6);
    // Four acked events, and rewriting the two left costs less than they take.
    journal.ack(4);
    expect(lines(dir).map((l) => l.seq)).toEqual([5, 6]);
    expect(journal.after(0).map((e) => e.seq)).toEqual([5, 6]);
    expect(stateOf(dir)).toMatchObject({ lastSeq: 6, ackedSeq: 4 });

    // Below the threshold nothing is rewritten; close drops what is acked.
    journal.ack(6);
    expect(lines(dir)).toHaveLength(2);
    journal.close();
    expect(lines(dir)).toEqual([]);
    expect(new Journal(dir).append(draining("next")).seq).toBe(7);

    // Acked events that are fewer than what is left stay until they outweigh it.
    const other = join(home, "other");
    const big = new Journal(other, { compactEntries: 2 });
    for (let i = 0; i < 10; i++) big.append(draining(`r${i}`));
    big.ack(4);
    expect(lines(other)).toHaveLength(10);
    big.ack(6);
    expect(lines(other)).toHaveLength(4);
    // Everything acked: the file empties, and the seq carries on after a restart (no close).
    big.ack(10);
    expect(lines(other)).toEqual([]);
    expect(new Journal(other).append(draining("next")).seq).toBe(11);
  });

  it("write the acked position at most every 250 ms while acks flow, and on close", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir);
    for (let i = 0; i < 5; i++) journal.append(draining(`r${i}`));
    io.renames = 0;

    journal.ack(1);
    journal.ack(2);
    vi.advanceTimersByTime(249);
    expect(io.renames).toBe(0);
    vi.advanceTimersByTime(1);
    expect(io.renames).toBe(1);
    expect(stateOf(dir)).toMatchObject({ ackedSeq: 2 });
    expect(lines(dir)).toHaveLength(5);

    journal.ack(3);
    journal.close();
    expect(stateOf(dir)).toMatchObject({ lastSeq: 5, ackedSeq: 3 });
    expect(lines(dir).map((l) => l.seq)).toEqual([4, 5]);
    vi.runAllTimers();
    expect(io.renames).toBe(3); // close cancelled the pending write
  });

  it("replay every unacked event after the runner is killed mid-stream", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir, { compactEntries: 10 });
    for (let i = 0; i < 30; i++) journal.append(draining(`r${i}`));
    for (let seq = 1; seq <= 30; seq++) journal.ack(seq); // compacts along the way
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
