import { z } from "zod";

/**
 * MCP over the runner link (`docs/remote-runners.md` §11). Agents always call the runner's own
 * MCP proxy (`http://127.0.0.1:<runnerPort>/mcp`). A runner in a sandbox can't reach the
 * server's loopback `/mcp`, so once the server configures it with `runner.configure { mcpLink:
 * true }`, its proxy turns each agent request into frames on the runner connection, and the
 * server answers them in-process with the same MCP handler and session-token check as `/mcp`:
 *
 *   runner -> `mcp.request` (method, allow-listed headers, body)
 *   server -> `mcp.response` part `head` (status, headers), then `chunk`s, then `end`
 *   runner -> `mcp.ack` as the agent reads the body (flow control), `mcp.cancel` if it leaves
 *
 * Bodies are base64, so bytes cross unchanged and a frame's size is known before it is sent.
 * Every request carries the agent's session token in `authorization`: these frames are never
 * journaled or logged.
 */

/** The largest request body the proxy sends over the link (8 MiB); bigger ones get 413. */
export const MCP_LINK_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Response body bytes per `chunk` frame, before base64 (256 KiB). */
export const MCP_LINK_CHUNK_BYTES = 256 * 1024;

/**
 * Response body bytes the server sends ahead of the runner's acks (1 MiB): a response the
 * agent reads slowly holds at most this much on the link and in the runner.
 */
export const MCP_LINK_WINDOW_BYTES = 1024 * 1024;

/** Requests one runner may have in flight; the server answers more with 429. */
export const MCP_LINK_MAX_IN_FLIGHT = 32;

/** Request headers the proxy passes on, over HTTP and over the link alike. */
export const MCP_REQUEST_HEADERS = [
  "authorization",
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

/** Response headers passed back to the agent, over HTTP and over the link alike. */
export const MCP_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
] as const;

/** Correlates an `mcp.request` with its `mcp.response` frames; chosen by the runner. */
export const McpLinkId = z.string().min(1).max(100);

/** Header names in lower case, mapped to their values. */
const Headers = z.record(z.string().max(100), z.string().max(8192));

const base64Of = (maxBytes: number) => z.base64().max(Math.ceil(maxBytes / 3) * 4);

/** An agent's HTTP request to the runner's `/mcp`, sent to the server. */
export const McpLinkRequest = z.object({
  type: z.literal("mcp.request"),
  id: McpLinkId,
  /** The HTTP method as the agent sent it (`POST`, `GET`, `DELETE`, ...). */
  method: z
    .string()
    .regex(/^[A-Z]+$/)
    .max(16),
  /** The request's `MCP_REQUEST_HEADERS` that were present; the server ignores any other. */
  headers: Headers,
  /** The body, base64; absent when there is none. */
  body: base64Of(MCP_LINK_MAX_REQUEST_BYTES).optional(),
});
export type McpLinkRequest = z.infer<typeof McpLinkRequest>;

/**
 * The agent went away (it disconnected, or stopped reading): the server aborts the request,
 * which ends the tool call, and sends nothing more for it.
 */
export const McpLinkCancel = z.object({ type: z.literal("mcp.cancel"), id: McpLinkId });
export type McpLinkCancel = z.infer<typeof McpLinkCancel>;

/** The agent has read `bytes` more of the response body: the server may send that much more. */
export const McpLinkAck = z.object({
  type: z.literal("mcp.ack"),
  id: McpLinkId,
  bytes: z.int().positive().max(MCP_LINK_WINDOW_BYTES),
});
export type McpLinkAck = z.infer<typeof McpLinkAck>;

/** The response's status and `MCP_RESPONSE_HEADERS`; its body follows in `chunk`s. */
const McpLinkResponseHead = z.object({
  type: z.literal("mcp.response"),
  id: McpLinkId,
  part: z.literal("head"),
  status: z.int().min(100).max(599),
  headers: Headers,
});

/** The next piece of the body, base64 (at most `MCP_LINK_CHUNK_BYTES` before encoding). */
const McpLinkResponseChunk = z.object({
  type: z.literal("mcp.response"),
  id: McpLinkId,
  part: z.literal("chunk"),
  data: base64Of(MCP_LINK_CHUNK_BYTES),
});

/**
 * The body is complete; with `error`, it broke off (the agent sees a dropped connection, as
 * when an HTTP response ends early). Before a `head`, the request failed outright.
 */
const McpLinkResponseEnd = z.object({
  type: z.literal("mcp.response"),
  id: McpLinkId,
  part: z.literal("end"),
  error: z.string().max(1000).optional(),
});

/** The server's answer to one `mcp.request`, streamed as `head`, `chunk`s and `end`. */
export const McpLinkResponse = z.discriminatedUnion("part", [
  McpLinkResponseHead,
  McpLinkResponseChunk,
  McpLinkResponseEnd,
]);
export type McpLinkResponse = z.infer<typeof McpLinkResponse>;

/** MCP frames the runner sends. */
export const McpLinkRunnerFrame = z.discriminatedUnion("type", [
  McpLinkRequest,
  McpLinkCancel,
  McpLinkAck,
]);
export type McpLinkRunnerFrame = z.infer<typeof McpLinkRunnerFrame>;
