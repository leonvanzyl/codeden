import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { MCP_TEST_MAX_PAGES, McpServerTestResult } from "@codeden/contracts";
import { Server as LowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunner } from "../src";
import { expandEnvVars, MissingEnvError, resolveMcpSpec } from "../src/mcp/resolve-spec";
import { testMcpServer } from "../src/mcp/server-test";
import { isAlive } from "../src/process/tree";
import { removeDir, TestServer, tempDir, waitUntil } from "./helpers";

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

/**
 * A stdio "server" that starts a long-lived helper (`detached` or not), writes the helper's
 * pid to `helper.pid`, then either refuses the handshake and stays up (`refuse`), or exits
 * (`exit`), leaving the helper behind as an orphan.
 */
const LEAKY_SERVER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [detached, mode] = process.argv.slice(2);
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: detached === "detached", stdio: "ignore", windowsHide: true,
});
helper.unref();
writeFileSync("helper.pid", String(helper.pid));
if (mode === "exit") { process.stderr.write("giving up\\n"); process.exit(1); }
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (message.method === "initialize") {
      const error = { code: -32603, message: "not today" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

describe("stopping a stdio server", () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir("codeden-mcp-leak-");
    writeFileSync(join(dir, "server.cjs"), LEAKY_SERVER);
  });
  afterAll(() => removeDir(dir));

  const runLeaky = async (detached: "detached" | "attached", mode: "refuse" | "exit") => {
    const tracked: number[] = [];
    const released: number[] = [];
    const result = await testMcpServer({
      spec: { type: "stdio", command: process.execPath, args: ["server.cjs", detached, mode] },
      cwd: dir,
      expandEnv: false,
      clientVersion: "0.0.0-test",
      timeoutMs: 15_000,
      supervisor: { adopt: (p) => tracked.push(p.pid), release: (pid) => released.push(pid) },
    });
    const helper = Number(readFileSync(join(dir, "helper.pid"), "utf8"));
    try {
      await waitUntil(() => !isAlive(helper), 5_000);
    } finally {
      if (isAlive(helper)) process.kill(helper);
    }
    return { result, tracked, released };
  };

  it("ends a helper the server detached when the handshake fails", async () => {
    const { result, tracked, released } = await runLeaky("detached", "refuse");
    expect(result).toMatchObject({ ok: false, stage: "connect", timedOut: false });
    expect(!result.ok && result.error).toContain("not today");
    expect(tracked).toHaveLength(1);
    expect(released).toEqual(tracked);
  }, 30_000);

  // On POSIX the orphan is only reachable through the server's process group. (On Windows
  // Node already ends a non-detached child with its parent.)
  it("ends what a server left behind when it exited during the handshake", async () => {
    const { result } = await runLeaky("attached", "exit");
    expect(result).toMatchObject({ ok: false, stage: "connect", stderrTail: "giving up" });
  }, 30_000);
});
