import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  MCP_TEST_MAX_PAGES,
  type McpServerSpec,
  McpServerTestResult,
  type McpStdioEnv,
} from "@codeden/contracts";
import { Server as LowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunner } from "../src";
import { expandEnvVars, MissingEnvError, resolveMcpSpec } from "../src/mcp/resolve-spec";
import { testMcpServer } from "../src/mcp/server-test";
import { codexEnvVarNames, stdioServerEnv } from "../src/mcp/stdio-env";
import type { SpawnServer } from "../src/mcp/stdio-transport";
import { killTreeAndOrphans } from "../src/process/tree";
import { removeDir, TestServer, tempDir } from "./helpers";

/** A server whose `tools/list` comes in pages of two tools: `pages` of them, or endless. */
function pagedServer(pages: number | "endless"): LowLevelServer {
  const server = new LowLevelServer(
    { name: "paged", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const page = Number(req.params?.cursor ?? 0);
    const last = pages !== "endless" && page === pages - 1;
    return {
      tools: [0, 1].map((i) => ({
        name: `t${page}_${i}`,
        inputSchema: { type: "object" as const },
      })),
      ...(last ? {} : { nextCursor: String(page + 1) }),
    };
  });
  return server;
}

/**
 * An MCP server on a local port (Streamable HTTP, stateless): `/mcp` answers anyone,
 * `/private` wants `Authorization: Bearer t1`, `/paged` lists 3 pages of tools and
 * `/endless` never stops paging. Every request's headers are recorded.
 */
async function fixtureServer(seen: IncomingHttpHeaders[]) {
  const http: Server = createServer(async (req, res) => {
    seen.push(req.headers);
    if (!["/mcp", "/private", "/paged", "/endless"].includes(req.url ?? "")) {
      res.writeHead(404).end("not here");
      return;
    }
    if (req.url === "/private" && req.headers.authorization !== "Bearer t1") {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    let mcp: McpServer | LowLevelServer;
    if (req.url === "/paged" || req.url === "/endless") {
      mcp = pagedServer(req.url === "/paged" ? 3 : "endless");
    } else {
      const named = new McpServer({ name: "fixture", version: "1.2.3" });
      named.registerTool("read_file", { description: "Reads a file" }, async () => ({
        content: [],
      }));
      named.registerTool("write_file", { title: "Write" }, async () => ({ content: [] }));
      mcp = named;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return { http, base: `http://127.0.0.1:${port}` };
}

describe("MCP spec resolution", () => {
  it("expands ${VAR} and ${VAR:-default} and collects missing variables", () => {
    const missing = new Set<string>();
    // A variable that is set, even to "", wins over the default.
    const env = { A: "one", EMPTY: "" };
    expect(expandEnvVars("${A}/${B:-two}/${EMPTY:-x}/${C:-}/$A", env, missing)).toBe(
      "one/two///$A",
    );
    expect(missing.size).toBe(0);
    expect(expandEnvVars("x-${NOPE}-${ALSO}", env, missing)).toBe("x-${NOPE}-${ALSO}");
    expect([...missing]).toEqual(["NOPE", "ALSO"]);
  });

  it("expands Claude specs, leaves Codex ones alone and adds Codex auth headers", () => {
    const env = { HOME_DIR: "/home/me", TOKEN: "t1", ORG: "acme" };
    expect(
      resolveMcpSpec(
        {
          type: "stdio",
          command: "${HOME_DIR}/bin/srv",
          args: ["--org=${ORG}"],
          env: { K: "${TOKEN}" },
        },
        { expandEnv: true, env },
      ),
    ).toEqual({
      type: "stdio",
      command: "/home/me/bin/srv",
      args: ["--org=acme"],
      env: { K: "t1" },
      cwd: undefined,
    });
    expect(
      resolveMcpSpec(
        { type: "stdio", command: "srv", args: ["${ORG}"] },
        { expandEnv: false, env },
      ),
    ).toMatchObject({ args: ["${ORG}"] });
    expect(
      resolveMcpSpec(
        {
          type: "http",
          url: "https://x/mcp",
          bearerTokenEnvVar: "TOKEN",
          extra: { env_http_headers: { "X-Org": "ORG", "X-Unset": "NOT_SET" } },
        },
        { expandEnv: false, env },
      ),
    ).toEqual({
      type: "http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer t1", "X-Org": "acme" },
    });
    expect(() =>
      resolveMcpSpec(
        { type: "http", url: "https://x/${NOPE}", bearerTokenEnvVar: "ALSO_NOPE" },
        { expandEnv: true, env },
      ),
    ).toThrow(new MissingEnvError(["NOPE", "ALSO_NOPE"]));
  });

  it("keeps one value per header whatever its casing, with the bearer variable winning", () => {
    const env = { TOKEN: "t1", ORG: "acme" };
    const headers = (spec: Record<string, unknown>) => {
      const resolved = resolveMcpSpec(
        { type: "http", url: "https://x/mcp", ...spec },
        { expandEnv: false, env },
      );
      return resolved.type === "stdio" ? null : resolved.headers;
    };
    // Two spellings in the file: the last one wins.
    expect(headers({ headers: { "X-A": "1", "x-a": "2" } })).toEqual({ "x-a": "2" });
    // The bearer variable replaces a static Authorization header of any casing.
    expect(
      headers({
        headers: { authorization: "Bearer stale", Accept: "x" },
        bearerTokenEnvVar: "TOKEN",
      }),
    ).toEqual({ Accept: "x", Authorization: "Bearer t1" });
    // env_http_headers replaces a static header of any casing.
    expect(
      headers({ headers: { "x-org": "static" }, extra: { env_http_headers: { "X-Org": "ORG" } } }),
    ).toEqual({ "X-Org": "acme" });
  });
});

describe("MCP connection test", () => {
  const seen: IncomingHttpHeaders[] = [];
  let fixture: Awaited<ReturnType<typeof fixtureServer>>;
  const run = (spec: Parameters<typeof testMcpServer>[0]["spec"], expandEnv = true) =>
    testMcpServer({
      spec,
      expandEnv,
      clientVersion: "0.0.0-test",
      env: { FIXTURE_KEY: "k1", FIXTURE_TOKEN: "t1" },
      timeoutMs: 10_000,
    });

  beforeAll(async () => {
    fixture = await fixtureServer(seen);
  });
  afterAll(() => new Promise<void>((resolve) => fixture.http.close(() => resolve())));

  it("runs the handshake and lists the tools, with the server's headers", async () => {
    seen.length = 0;
    const result = await run({
      type: "http",
      url: `${fixture.base}/mcp`,
      headers: { "X-Api-Key": "${FIXTURE_KEY}" },
    });
    expect(McpServerTestResult.parse(result)).toEqual(result);
    if (!result.ok) throw new Error(result.error);
    expect(result.server).toEqual({ name: "fixture", version: "1.2.3" });
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.toolCount).toBe(2);
    expect(result.tools).toEqual([
      { name: "read_file", description: "Reads a file" },
      { name: "write_file", title: "Write" },
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h["x-api-key"] === "k1")).toBe(true);
  });

  it("sends a Codex bearer token, and reports a 401 as a sign-in problem", async () => {
    // A stale `authorization` header in another casing is replaced, not joined to the token
    // (`Bearer stale, Bearer t1` would be refused).
    const codex = await run(
      {
        type: "http",
        url: `${fixture.base}/private`,
        headers: { authorization: "Bearer stale" },
        bearerTokenEnvVar: "FIXTURE_TOKEN",
      },
      false,
    );
    expect(codex.ok).toBe(true);
    const claude = await run({
      type: "http",
      url: `${fixture.base}/private`,
      headers: { Authorization: "Bearer stale", authorization: "Bearer ${FIXTURE_TOKEN}" },
    });
    expect(claude.ok).toBe(true);

    const denied = await run({ type: "http", url: `${fixture.base}/private` }, false);
    expect(denied).toMatchObject({ ok: false, stage: "connect", timedOut: false });
    expect(!denied.ok && denied.error).toMatch(/^Unauthorized \(401\): the server needs a sign-in/);
  });

  it("fails at the start for a missing variable or a bad URL, and at connect for a 404", async () => {
    const missing = await run({ type: "http", url: `${fixture.base}/\${NOT_SET}` });
    expect(missing).toMatchObject({
      ok: false,
      stage: "start",
      error: "Environment variable NOT_SET is not set",
    });
    expect(await run({ type: "http", url: "not a url" })).toMatchObject({
      ok: false,
      stage: "start",
      error: "Not a valid URL: not a url",
    });
    const notFound = await run({ type: "http", url: `${fixture.base}/elsewhere` });
    expect(notFound).toMatchObject({ ok: false, stage: "connect", timedOut: false });
    expect(McpServerTestResult.parse(notFound)).toEqual(notFound);
  });

  it("follows every page of tools, and says so when it stops at the page cap", async () => {
    const paged = await run({ type: "http", url: `${fixture.base}/paged` });
    expect(paged).toMatchObject({ ok: true, toolCount: 6, morePages: false });
    expect(paged.ok && paged.tools.map((t) => t.name)).toEqual([
      "t0_0",
      "t0_1",
      "t1_0",
      "t1_1",
      "t2_0",
      "t2_1",
    ]);
    const endless = await run({ type: "http", url: `${fixture.base}/endless` });
    expect(endless).toMatchObject({ ok: true, toolCount: MCP_TEST_MAX_PAGES * 2, morePages: true });
  });

  it("answers the mcp.test runner command", async () => {
    const home = tempDir("codeden-mcp-cmd-");
    const runner = await startRunner({ home });
    const server = await TestServer.attach(runner);
    try {
      const result = await server.request({
        name: "mcp.test",
        spec: { type: "http", url: `${fixture.base}/mcp` },
        expandEnv: false,
        timeoutMs: 10_000,
      });
      expect(result).toMatchObject({ ok: true, server: { name: "fixture" }, toolCount: 2 });
    } finally {
      await server.close();
      await runner.close();
      removeDir(home);
    }
  });

  it("fails at the start when a stdio server's working folder is missing", async () => {
    const result = await testMcpServer({
      spec: { type: "stdio", command: "node" },
      cwd: "/definitely/not/a/folder",
      expandEnv: false,
      clientVersion: "0.0.0-test",
      env: {},
    });
    expect(result).toMatchObject({ ok: false, stage: "start" });
    expect(!result.ok && result.error).toContain("Working folder not found");
  });
});

type Rpc = { id?: number; method?: string };

/**
 * A stdio server process that only exists in memory: its stdin, stdout and stderr are
 * streams, and `answer` decides what it does with each message the client writes.
 */
class FakeServerProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(answer: (message: Rpc, server: FakeServerProcess) => void) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        answer(JSON.parse(line) as Rpc, this);
      }
    });
    process.nextTick(() => this.emit("spawn"));
  }

  reply(id: number | undefined, body: { result: unknown } | { error: unknown }): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  }

  /** The process ends (after what it wrote has been read). */
  exit(): void {
    setImmediate(() => this.emit("close", 1, null));
  }
}

describe("stopping a stdio server", () => {
  const runFake = async (answer: (message: Rpc, server: FakeServerProcess) => void) => {
    const spawned: Array<{ command: string; options: unknown }> = [];
    const stopped: number[] = [];
    const adopted: number[] = [];
    const released: number[] = [];
    const spawn: SpawnServer = (command, _args, options) => {
      spawned.push({ command, options });
      return new FakeServerProcess(answer) as unknown as ChildProcess;
    };
    const result = await testMcpServer({
      spec: { type: "stdio", command: "fake-server", env: { A: "1" } },
      cwd: tmpdir(),
      expandEnv: false,
      clientVersion: "0.0.0-test",
      env: { PATH: "/bin" },
      spawn,
      stopTree: async (pid) => {
        stopped.push(pid);
      },
      supervisor: { adopt: (p) => adopted.push(p.pid), release: (pid) => released.push(pid) },
    });
    return { result, spawned, stopped, adopted, released };
  };

  it("starts the server as a group leader and stops its tree after a successful test", async () => {
    const { result, spawned, stopped, adopted, released } = await runFake((message, server) => {
      if (message.method === "initialize") {
        server.stdout.write("starting up...\n"); // a log line on stdout is skipped
        server.reply(message.id, {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stdio", version: "2.0.0" },
          },
        });
      } else if (message.method === "tools/list") {
        server.reply(message.id, {
          result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
        });
      }
    });
    expect(result).toMatchObject({
      ok: true,
      server: { name: "fake-stdio", version: "2.0.0" },
      protocolVersion: "2025-06-18",
      toolCount: 1,
      tools: [{ name: "echo" }],
    });
    expect(spawned).toEqual([
      {
        command: "fake-server",
        options: expect.objectContaining({
          cwd: tmpdir(),
          env: { PATH: "/bin", A: "1" },
          windowsHide: true,
          detached: process.platform !== "win32",
        }),
      },
    ]);
    expect(stopped).toEqual([4242]);
    expect(adopted).toEqual([4242]);
    expect(released).toEqual([4242]);
  });

  it("stops the tree of a server that refuses the handshake and stays up", async () => {
    const { result, stopped, released } = await runFake((message, server) => {
      if (message.method === "initialize") {
        server.reply(message.id, { error: { code: -32603, message: "not today" } });
      }
    });
    expect(result).toMatchObject({ ok: false, stage: "connect", timedOut: false });
    expect(!result.ok && result.error).toContain("not today");
    // The client has closed the transport by now; the pid from spawn is still used.
    expect(stopped).toEqual([4242]);
    expect(released).toEqual([4242]);
  });

  it("stops the tree of a server that exited during the handshake", async () => {
    const { result, stopped } = await runFake((message, server) => {
      if (message.method === "initialize") {
        server.stderr.write("giving up\n");
        server.exit();
      }
    });
    expect(result).toMatchObject({ ok: false, stage: "connect", stderrTail: "giving up" });
    // What it started may outlive it, so its tree is still stopped by the pid from spawn.
    expect(stopped).toEqual([4242]);
  });

  it("kills descendants listed before the tree, then the process group on POSIX", async () => {
    const run = async (platform: NodeJS.Platform, descendants: Promise<number[]>) => {
      const calls: string[] = [];
      await killTreeAndOrphans(10, 500, {
        platform,
        listDescendants: async (pid) => {
          calls.push(`list ${pid}`);
          return descendants;
        },
        killTree: async (pid) => {
          calls.push(`kill ${pid}`);
        },
        killGroup: (pid) => calls.push(`group ${pid}`),
      });
      return calls;
    };
    expect(await run("linux", Promise.resolve([11, 12]))).toEqual([
      "list 10",
      "kill 10",
      "kill 11",
      "kill 12",
      "group 10",
    ]);
    // Windows has no process groups: children of an exited process are found by parent id.
    expect(await run("win32", Promise.resolve([11]))).toEqual(["list 10", "kill 10", "kill 11"]);
    // A failed listing still kills the tree.
    expect(await run("darwin", Promise.reject(new Error("ps failed")))).toEqual([
      "list 10",
      "kill 10",
      "group 10",
    ]);
  });
});

describe("a stdio server's environment", () => {
  const runner = { PATH: "/bin", HOME: "/home/me", GITHUB_TOKEN: "t1", DATABASE_URL: "db" };

  /** Tests a server that exits at `initialize` unless `GITHUB_TOKEN` is in its environment. */
  const runNeedsToken = async (spec: Pick<McpServerSpec, "extra">, stdioEnv?: McpStdioEnv) => {
    let serverEnv: Record<string, string | undefined> = {};
    const spawn: SpawnServer = (_command, _args, options) => {
      serverEnv = { ...options?.env };
      return new FakeServerProcess((message, server) => {
        if (message.method !== "initialize") return;
        if (!serverEnv.GITHUB_TOKEN) {
          server.stderr.write("GITHUB_TOKEN is not set\n");
          server.exit();
          return;
        }
        server.reply(message.id, {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "needs-token", version: "1" },
          },
        });
      }) as unknown as ChildProcess;
    };
    const result = await testMcpServer({
      spec: { type: "stdio", command: "github-mcp", env: { A: "1" }, ...spec },
      cwd: tmpdir(),
      expandEnv: stdioEnv !== "allowlist",
      ...(stdioEnv ? { stdioEnv } : {}),
      platform: "linux",
      clientVersion: "0.0.0-test",
      env: runner,
      spawn,
      stopTree: async () => undefined,
    });
    return { result, serverEnv };
  };

  it("gives a Codex server only the default variables, its env_vars and its env", async () => {
    // Codex wouldn't start it with the runner's GITHUB_TOKEN, so the test fails too.
    const missing = await runNeedsToken({}, "allowlist");
    expect(missing.result).toMatchObject({
      ok: false,
      stage: "connect",
      stderrTail: "GITHUB_TOKEN is not set",
      note: expect.stringContaining("add its name to the server's env_vars"),
    });
    expect(missing.serverEnv).toEqual({ PATH: "/bin", HOME: "/home/me", A: "1" });

    const listed = await runNeedsToken({ extra: { env_vars: ["GITHUB_TOKEN"] } }, "allowlist");
    expect(listed.result).toMatchObject({ ok: true, server: { name: "needs-token" } });
    expect(listed.serverEnv).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      GITHUB_TOKEN: "t1",
      A: "1",
    });
  });

  it("gives a Claude server the runner's whole environment", async () => {
    const claude = await runNeedsToken({});
    expect(claude.result).toMatchObject({ ok: true });
    expect(claude.serverEnv).toEqual({ ...runner, A: "1" });
  });

  it("follows Codex's rules: Windows names in any case, CA bundles, local env_vars only", () => {
    expect(
      codexEnvVarNames({
        env_vars: ["A", { name: "B", source: "local" }, { name: "C", source: "remote" }, 5],
      }),
    ).toEqual(["A", "B"]);
    expect(
      stdioServerEnv({
        policy: "allowlist",
        base: {
          Path: "C:\\bin",
          SystemRoot: "C:\\Windows",
          Github_Token: "t1",
          NODE_EXTRA_CA_CERTS: "ca.pem",
          SSL_CERT_FILE: "",
          DATABASE_URL: "db",
        },
        envVars: ["GITHUB_TOKEN"],
        // The server's own env wins over a default of any casing.
        serverEnv: { path: "D:\\bin" },
        platform: "win32",
      }),
    ).toEqual({
      SYSTEMROOT: "C:\\Windows",
      GITHUB_TOKEN: "t1",
      NODE_EXTRA_CA_CERTS: "ca.pem",
      path: "D:\\bin",
    });
  });
});
