import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServerTestResult } from "@codeden/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandEnvVars, MissingEnvError, resolveMcpSpec } from "../src/mcp/resolve-spec";
import { testMcpServer } from "../src/mcp/server-test";

/**
 * An MCP server on a local port (Streamable HTTP, stateless): `/mcp` answers anyone,
 * `/private` wants `Authorization: Bearer t1`. Every request's headers are recorded.
 */
async function fixtureServer(seen: IncomingHttpHeaders[]) {
  const http: Server = createServer(async (req, res) => {
    seen.push(req.headers);
    if (req.url !== "/mcp" && req.url !== "/private") {
      res.writeHead(404).end("not here");
      return;
    }
    if (req.url === "/private" && req.headers.authorization !== "Bearer t1") {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    const mcp = new McpServer({ name: "fixture", version: "1.2.3" });
    mcp.registerTool("read_file", { description: "Reads a file" }, async () => ({ content: [] }));
    mcp.registerTool("write_file", { title: "Write" }, async () => ({ content: [] }));
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
    const codex = await run(
      { type: "http", url: `${fixture.base}/private`, bearerTokenEnvVar: "FIXTURE_TOKEN" },
      false,
    );
    expect(codex.ok).toBe(true);

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
