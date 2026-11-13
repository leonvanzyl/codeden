import {
  type AgentEvent,
  type Item,
  OUTPUT_PREVIEW_CHARS,
  STREAMED_OUTPUT_CHARS,
} from "@codeden/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { previewRecord } from "../src/services/sessions/preview";
import { sampleSession } from "./helpers";
import { MemoryProjection } from "./support/memory-projection";

const T = "t-root";
const U = "u1";
const CHUNK = 4096;
const CHUNKS = 2000;

const command: Item = {
  id: "c1",
  kind: "tool_call",
  toolKind: "command",
  status: "in_progress",
  toolName: "shell",
  command: "pnpm build",
};

let p: MemoryProjection;

beforeEach(() => {
  p = new MemoryProjection();
  p.addSession({ ...sampleSession, status: "starting", projectId: "p1" });
  p.apply(
    "s1",
    { type: "thread.started", thread: { id: T } },
    { type: "turn.started", threadId: T, turnId: U },
    { type: "item.started", threadId: T, turnId: U, item: command },
  );
});

/** A 4 KB block of output tagged with its index, so the kept tail can be checked. */
const line = (i: number) => `${String(i).padStart(6, "0")}${"x".repeat(CHUNK - 7)}\n`;

const chunk = (i: number): AgentEvent => ({
  type: "item.delta",
  threadId: T,
  turnId: U,
  itemId: "c1",
  delta: { type: "tool_output", text: line(i), stream: "stdout" },
});

describe("streamed tool output", () => {
  it("keeps a bounded tail of a long command's output instead of all of it", () => {
    let last: ReturnType<MemoryProjection["apply"]> = [];
    for (let i = 0; i < CHUNKS; i++) last = p.apply("s1", chunk(i));

    const record = p.item("c1");
    const item = record?.item;
    if (!record || item?.kind !== "tool_call" || !item.output) throw new Error("no tool output");
    const { output } = item;

    // The stored copy is capped and marked truncated, with the full streamed size recorded.
    expect(output.text.length).toBe(STREAMED_OUTPUT_CHARS);
    expect(output.truncated).toBe(true);
    expect(output.totalBytes).toBe(CHUNK * CHUNKS);
    // The end of command output is the useful part: exactly the latest output is kept.
    const recent = Array.from({ length: 17 }, (_, j) => line(CHUNKS - 17 + j)).join("");
    expect(output.text).toBe(recent.slice(recent.length - STREAMED_OUTPUT_CHARS));

    // Each chunk rewrites a bounded row, not the whole output so far.
    expect(JSON.stringify(last).length).toBeLessThan(STREAMED_OUTPUT_CHARS + 2 * CHUNK);

    // The live transcript still shows the latest output and the full size.
    const live = previewRecord(record).item;
    expect(live.kind === "tool_call" && live.output).toMatchObject({
      truncated: true,
      totalBytes: CHUNK * CHUNKS,
    });
    expect(live.kind === "tool_call" && live.output?.text).toBe(
      output.text.slice(output.text.length - OUTPUT_PREVIEW_CHARS),
    );

    // Completion is authoritative, as before.
    const done = { text: "done\n", truncated: false, totalBytes: 5 };
    p.apply("s1", {
      type: "item.completed",
      threadId: T,
      turnId: U,
      item: { ...command, status: "completed", output: done },
    });
    const final = p.item("c1")?.item;
    expect(final?.kind === "tool_call" && final.output).toEqual(done);
  });
});
