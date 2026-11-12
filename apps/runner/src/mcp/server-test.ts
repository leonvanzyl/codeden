import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  MCP_TEST_DEFAULT_TIMEOUT_MS,
  MCP_TEST_DESCRIPTION_LIMIT,
  MCP_TEST_ERROR_LIMIT,
  MCP_TEST_MAX_TOOLS,
  MCP_TEST_STDERR_LIMIT,
  type McpServerSpec,
  type McpServerTestResult,
  type McpTestStage,
  type McpTestTool,
} from "@codeden/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { childEnv } from "../process/env";
import { killTree } from "../process/tree";
import { type ResolvedMcpServer, resolveMcpSpec } from "./resolve-spec";

/** Pages of `tools/list` followed before the list is cut off. */
const MAX_TOOL_PAGES = 20;

export interface McpServerTestOptions {
  spec: McpServerSpec;
  /** Working directory of a stdio server without its own `cwd`; the home folder when omitted. */
  cwd?: string;
  /** Expand `${VAR}` placeholders (Claude Code's config). */
  expandEnv: boolean;
  timeoutMs?: number;
  /** Reported to the server as the client version. */
  clientVersion: string;
  /** Environment for placeholders and stdio servers; the runner's (minus secrets) by default. */
  env?: Record<string, string>;
}

/** Keeps the last `limit` characters written to it. */
class TailBuffer {
  private text = "";
  constructor(private readonly limit: number) {}
  append(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.limit * 2);
  }
  value(): string | undefined {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
    const clean = this.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
    return clean ? clean.slice(-this.limit) : undefined;
  }
}

/**
 * Connect to an MCP server as an agent would (§12.4): start it (stdio) or reach its URL
 * (http/sse), run the `initialize` handshake and `tools/list`, then stop it. Never throws:
 * a server that fails is an `ok: false` result with the stage, the error and (stdio) the end
 * of its stderr.
 */
export async function testMcpServer(opts: McpServerTestOptions): Promise<McpServerTestResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const timeoutMs = opts.timeoutMs ?? MCP_TEST_DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? childEnv();
  const stderr = new TailBuffer(MCP_TEST_STDERR_LIMIT);
  let stage: McpTestStage = "start";
  let timedOut = false;
  let protocolVersion: string | null = null;
  let stdio: StdioClientTransport | null = null;

  const fail = (error: unknown): McpServerTestResult => {
    const tail = stderr.value();
    return {
      ok: false,
      durationMs: elapsed(),
      stage,
      error: describeError(error, { timedOut, timeoutMs, type: opts.spec.type }),
      timedOut,
      ...(tail ? { stderrTail: tail } : {}),
    };
  };

  const client = new Client({ name: "codeden-mcp-test", version: opts.clientVersion });
  try {
    const server = resolveMcpSpec(opts.spec, { expandEnv: opts.expandEnv, env });
    const transport: Transport = createTransport(server, { cwd: opts.cwd, env, stderr });
    // The client starts the transport, then negotiates the protocol version; both are
    // observed here so a failure names its stage and a success reports the version.
    const start = transport.start.bind(transport);
    transport.start = async () => {
      await start();
      stage = "connect";
    };
    const setVersion = transport.setProtocolVersion?.bind(transport);
    transport.setProtocolVersion = (version: string) => {
      protocolVersion = version;
      setVersion?.(version);
    };
    if (transport instanceof StdioClientTransport) stdio = transport;

    const work = (async () => {
      await client.connect(transport, { timeout: timeoutMs });
      stage = "list_tools";
      return listTools(client, timeoutMs);
    })();
    const { toolCount, tools } = await withTimeout(work, timeoutMs, () => {
      timedOut = true;
    });
    const info = client.getServerVersion();
    return {
      ok: true,
      durationMs: elapsed(),
      server: {
        name: info?.name ?? "",
        version: info?.version ?? "",
        ...(info?.title ? { title: info.title } : {}),
      },
      protocolVersion,
      toolCount,
      tools,
    };
  } catch (error) {
    return fail(error);
  } finally {
    await stop(client, stdio);
  }
}

function createTransport(
  server: ResolvedMcpServer,
  ctx: { cwd: string | undefined; env: Record<string, string>; stderr: TailBuffer },
): Transport {
  if (server.type === "stdio") {
    const cwd = server.cwd ?? ctx.cwd ?? homedir();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Working folder not found: ${cwd}`);
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...ctx.env, ...server.env },
      cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => ctx.stderr.append(String(chunk)));
    return transport;
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`Not a valid URL: ${server.url}`);
  }
  const requestInit = { headers: server.headers };
  return server.type === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

async function listTools(
  client: Client,
  timeoutMs: number,
): Promise<{ toolCount: number; tools: McpTestTool[] }> {
  if (!client.getServerCapabilities()?.tools) return { toolCount: 0, tools: [] };
  const tools: McpTestTool[] = [];
  let toolCount = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    toolCount += result.tools.length;
    for (const tool of result.tools) {
      if (tools.length >= MCP_TEST_MAX_TOOLS) break;
      tools.push({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description
          ? { description: tool.description.slice(0, MCP_TEST_DESCRIPTION_LIMIT) }
          : {}),
      });
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { toolCount, tools };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  // The work is abandoned (and the transport closed) on timeout; its rejection is expected.
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("timed out"));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Stop the server: the whole process tree first (wrappers such as `npx`), then the client. */
async function stop(client: Client, stdio: StdioClientTransport | null): Promise<void> {
  const pid = stdio?.pid ?? null;
  if (pid !== null) await killTree(pid, 1_000).catch(() => undefined);
  await client.close().catch(() => undefined);
}

function describeError(
  error: unknown,
  ctx: { timedOut: boolean; timeoutMs: number; type: McpServerSpec["type"] },
): string {
  let message: string;
  if (ctx.timedOut) {
    message = `No answer within ${Math.round(ctx.timeoutMs / 1000)} s; the server was stopped`;
  } else if (error instanceof Error) {
    message = error.message;
    const code = (error as { code?: unknown }).code;
    if (ctx.type !== "stdio" && (code === 401 || /\b401\b/.test(message))) {
      message = `Unauthorized (401): the server needs a sign-in, which the agent's CLI does and this test can't. ${message}`;
    }
    // `fetch failed` hides the reason (refused, DNS, TLS) in its cause.
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && !message.includes(cause.message)) {
      message = `${message}: ${cause.message}`;
    }
    if (/connection closed/i.test(message) && ctx.type === "stdio") {
      message = `${message}. The server stopped before it answered`;
    }
  } else {
    message = String(error);
  }
  return message.slice(0, MCP_TEST_ERROR_LIMIT);
}
