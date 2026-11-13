import { describe, expect, it } from "vitest";
import {
  describeRunnerLinkExit,
  encodeLinkFrame,
  type LinkDropReason,
  LinkFrameDecoder,
  RUNNER_LINK_MAX_LINE_BYTES,
  RunnerLinkExit,
} from "../src";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A decoder that records what it dropped. */
function decoder(maxBytes?: number) {
  const drops: Array<[LinkDropReason, number]> = [];
  const d = new LinkFrameDecoder({ maxBytes, onDrop: (reason, n) => drops.push([reason, n]) });
  return { d, drops };
}

/** Feed `data` in chunks of `size` bytes; every message decoded. */
function feed(d: LinkFrameDecoder, data: Uint8Array, size: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < data.length; i += size) out.push(...d.push(data.subarray(i, i + size)));
  return out;
}

/** A JSON string message whose frame (without "\n") is exactly `n` bytes. */
const messageOfBytes = (n: number) => "x".repeat(n - 2);

describe("runner link framing", () => {
  const messages = [
    { type: "hello", protocolVersion: 1, serverVersion: "0.6.3" },
    { type: "event", seq: 2, text: "multi\nline\r\nand   separators" },
    { type: "stream", text: "naïve café — 日本語 🧪" },
    [1, "two", null, true],
  ];
  const stream = bytes(messages.map((m) => encodeLinkFrame(m)).join(""));

  it("round-trips messages, one compact line each", () => {
    for (const m of messages) {
      const frame = encodeLinkFrame(m) as string;
      expect(frame.endsWith("\n")).toBe(true);
      expect(frame.slice(0, -1)).not.toMatch(/[\r\n]/);
    }
    const { d, drops } = decoder();
    expect(d.push(stream)).toEqual(messages);
    expect(drops).toEqual([]);
    expect(d.buffered).toBe(0);
  });

  it("reassembles lines and characters split across chunks, one byte at a time too", () => {
    for (const size of [1, 2, 3, 7, 64]) {
      const { d, drops } = decoder();
      expect(feed(d, stream, size)).toEqual(messages);
      expect(drops).toEqual([]);
    }
  });

  it("tolerates CRLF line ends and skips empty lines", () => {
    const { d, drops } = decoder();
    expect(d.push(bytes('\n\r\n{"a":1}\r\n  \n{"b":2}\n'))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(drops).toEqual([]);
  });

  it("keeps a partial line until its newline arrives, and never delivers it otherwise", () => {
    const { d } = decoder();
    expect(d.push(bytes('{"a":'))).toEqual([]);
    expect(d.buffered).toBe(5);
    expect(d.push(bytes('1}\n{"b"'))).toEqual([{ a: 1 }]);
    expect(d.buffered).toBe(4);
  });

  it("ignores lines that are not JSON, and goes on", () => {
    const { d, drops } = decoder();
    const out = d.push(bytes('{"a":1}\nnot json\n{"broken":\n{"b":2}\n'));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
    expect(drops).toEqual([
      ["invalid_json", 8],
      ["invalid_json", 10],
    ]);
  });

  it("accepts a line of exactly the 16 MiB limit", () => {
    const big = messageOfBytes(RUNNER_LINK_MAX_LINE_BYTES);
    const frame = encodeLinkFrame(big) as string;
    expect(frame.length).toBe(RUNNER_LINK_MAX_LINE_BYTES + 1);
    const { d, drops } = decoder();
    const out = feed(d, bytes(`${frame}{"after":true}\n`), 64 * 1024);
    expect(out).toHaveLength(2);
    expect((out[0] as string).length).toBe(big.length);
    expect(out[1]).toEqual({ after: true });
    expect(drops).toEqual([]);
  });

  it("rejects a line over the limit cleanly: never buffered whole, and the next line decodes", () => {
    const tooBig = messageOfBytes(RUNNER_LINK_MAX_LINE_BYTES + 1);
    expect(encodeLinkFrame(tooBig)).toBeNull();
    const { d, drops } = decoder();
    const line = `${JSON.stringify(tooBig)}\n`;
    let peak = 0;
    const out: unknown[] = [];
    const data = bytes(`{"before":1}\n${line}{"after":2}\n`);
    for (let i = 0; i < data.length; i += 1024 * 1024) {
      out.push(...d.push(data.subarray(i, i + 1024 * 1024)));
      peak = Math.max(peak, d.buffered);
    }
    expect(out).toEqual([{ before: 1 }, { after: 2 }]);
    expect(drops).toEqual([["too_large", RUNNER_LINK_MAX_LINE_BYTES + 1]]);
    expect(peak).toBeLessThanOrEqual(RUNNER_LINK_MAX_LINE_BYTES + 1);
    expect(d.buffered).toBe(0);
  });

  it("applies a smaller limit, counting UTF-8 bytes", () => {
    const { d, drops } = decoder(8);
    // "é" is 2 bytes: `"éé"` is 6 bytes, `"ééé"` is 8, `"éééé"` is 10.
    expect(d.push(bytes('"éé"\n"ééé"\n"éééé"\n1\n'))).toEqual(["éé", "ééé", 1]);
    expect(drops).toEqual([["too_large", 10]]);
    expect(encodeLinkFrame("ééé", 8)).toBe('"ééé"\n');
    expect(encodeLinkFrame("éééé", 8)).toBeNull();
    expect(encodeLinkFrame(undefined)).toBeNull();
  });

  it("names every exit code of runner-link", () => {
    expect(RunnerLinkExit).toEqual({ closed: 0, failed: 1, usage: 2, noRunner: 3, rejected: 4 });
    expect(describeRunnerLinkExit(RunnerLinkExit.noRunner)).toMatch(/no runner/);
    expect(describeRunnerLinkExit(RunnerLinkExit.rejected)).toMatch(/rejected/);
    expect(describeRunnerLinkExit(null)).toMatch(/killed/);
    expect(describeRunnerLinkExit(9)).toMatch(/code 9/);
  });
});
