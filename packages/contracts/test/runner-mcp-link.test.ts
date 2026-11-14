import { describe, expect, it } from "vitest";
import {
  encodeLinkFrame,
  MCP_LINK_CHUNK_BYTES,
  MCP_LINK_MAX_REQUEST_BYTES,
  MCP_LINK_WINDOW_BYTES,
  RunnerCommand,
  RunnerToServerMessage,
  ServerToRunnerMessage,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("MCP over the runner link (frames)", () => {
  it("round-trips requests, cancels and acks from the runner", () => {
    roundTrip(RunnerToServerMessage, {
      type: "mcp.request",
      id: "m1",
      method: "POST",
      headers: { authorization: "Bearer cdm_x", accept: "application/json, text/event-stream" },
      body: b64('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
    });
    roundTrip(RunnerToServerMessage, {
      type: "mcp.request",
      id: "m2",
      method: "DELETE",
      headers: {},
    });
    roundTrip(RunnerToServerMessage, { type: "mcp.cancel", id: "m1" });
    roundTrip(RunnerToServerMessage, { type: "mcp.ack", id: "m1", bytes: 1024 });
  });

  it("round-trips a response's head, chunks and end from the server", () => {
    roundTrip(ServerToRunnerMessage, {
      type: "mcp.response",
      id: "m1",
      part: "head",
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    roundTrip(ServerToRunnerMessage, {
      type: "mcp.response",
      id: "m1",
      part: "chunk",
      data: b64('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
    });
    roundTrip(ServerToRunnerMessage, { type: "mcp.response", id: "m1", part: "end" });
    roundTrip(ServerToRunnerMessage, {
      type: "mcp.response",
      id: "m1",
      part: "end",
      error: "the tool failed",
    });
  });

  it("refuses frames that break the limits", () => {
    const tooBig = "A".repeat((Math.ceil(MCP_LINK_MAX_REQUEST_BYTES / 3) + 1) * 4);
    const request = { type: "mcp.request", id: "m1", method: "POST", headers: {} };
    expect(RunnerToServerMessage.safeParse({ ...request, body: tooBig }).success).toBe(false);
    expect(RunnerToServerMessage.safeParse({ ...request, body: "not base64!" }).success).toBe(
      false,
    );
    expect(RunnerToServerMessage.safeParse({ ...request, method: "post" }).success).toBe(false);
    const ack = { type: "mcp.ack", id: "m1" };
    expect(RunnerToServerMessage.safeParse({ ...ack, bytes: 0 }).success).toBe(false);
    expect(
      RunnerToServerMessage.safeParse({ ...ack, bytes: MCP_LINK_WINDOW_BYTES + 1 }).success,
    ).toBe(false);
    const chunk = "A".repeat((Math.ceil(MCP_LINK_CHUNK_BYTES / 3) + 1) * 4);
    expect(
      ServerToRunnerMessage.safeParse({
        type: "mcp.response",
        id: "m1",
        part: "chunk",
        data: chunk,
      }).success,
    ).toBe(false);
  });

  it("fits the largest request body in one link frame", () => {
    const body = "A".repeat(Math.ceil(MCP_LINK_MAX_REQUEST_BYTES / 3) * 4);
    const frame = { type: "mcp.request", id: "x".repeat(100), method: "POST", headers: {}, body };
    expect(RunnerToServerMessage.safeParse(frame).success).toBe(true);
    expect(encodeLinkFrame(frame)).not.toBeNull();
  });

  it("configures the proxy for the link", () => {
    const command = roundTrip(RunnerCommand, {
      name: "runner.configure",
      mcpUpstreamUrl: null,
      mcpLink: true,
    });
    expect(command).toEqual({ name: "runner.configure", mcpUpstreamUrl: null, mcpLink: true });
  });
});
