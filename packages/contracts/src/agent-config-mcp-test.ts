import { z } from "zod";
import { McpServerSpec, McpServerTarget } from "./agent-config";

/**
 * Connection test of one MCP server (§12.4): the runner connects to it as an agent would,
 * runs the MCP `initialize` handshake and `tools/list`, then stops it.
 */

/** Most tools listed in a test result (`toolCount` is the full number). */
export const MCP_TEST_MAX_TOOLS = 500;
/** Most `tools/list` pages a test follows; beyond them `morePages` is set. */
export const MCP_TEST_MAX_PAGES = 100;
/** Most characters of a tool description kept in a test result. */
export const MCP_TEST_DESCRIPTION_LIMIT = 300;
/** Most characters of the error message of a failed test. */
export const MCP_TEST_ERROR_LIMIT = 2000;
/** Most characters of a stdio server's stderr kept in a failed test (its end). */
export const MCP_TEST_STDERR_LIMIT = 4000;
/** Default time a test may take, including a first-run `npx` download. */
export const MCP_TEST_DEFAULT_TIMEOUT_MS = 60_000;
/** Longest timeout a test may ask for. */
export const MCP_TEST_MAX_TIMEOUT_MS = 120_000;

/**
 * `POST /api/agent-config/mcp/test`. With `spec`, those (unsaved) values are tested, as from
 * the add/edit dialog; without it, the server saved at the target is.
 */
export const McpServerTestRequest = McpServerTarget.extend({ spec: McpServerSpec.optional() });
export type McpServerTestRequest = z.infer<typeof McpServerTestRequest>;

/**
 * How a connection test builds a stdio server's environment, the way the agent's CLI does:
 * - `inherit` (Claude Code): the runner's environment, minus CodeDen's own secrets, plus the
 *   server's `env`.
 * - `allowlist` (Codex): only the platform's default variables (PATH, HOME or USERPROFILE, the
 *   temp folder and the like) and CA bundle variables, the names in the server's native
 *   `env_vars` list (kept in the spec's `extra`), then the server's `env`.
 */
export const McpStdioEnv = z.enum(["inherit", "allowlist"]);
export type McpStdioEnv = z.infer<typeof McpStdioEnv>;

/** One tool a server offers. */
export const McpTestTool = z.object({
  name: z.string(),
  title: z.string().optional(),
  /** Cut to `MCP_TEST_DESCRIPTION_LIMIT` characters. */
  description: z.string().max(MCP_TEST_DESCRIPTION_LIMIT).optional(),
});
export type McpTestTool = z.infer<typeof McpTestTool>;

/** Where a failed test stopped: starting the server, the handshake, or listing its tools. */
export const McpTestStage = z.enum(["start", "connect", "list_tools"]);
export type McpTestStage = z.infer<typeof McpTestStage>;

/**
 * Result of a connection test (the `mcp.test` runner command and the HTTP route). A server
 * that fails is a result with `ok: false`, never a request error.
 */
export const McpServerTestResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** Wall time from start to the end of `tools/list`. */
    durationMs: z.int().nonnegative(),
    /** What the server reported in `initialize`. */
    server: z.object({ name: z.string(), version: z.string(), title: z.string().optional() }),
    /** The protocol version both sides agreed on, when known. */
    protocolVersion: z.string().nullable(),
    /**
     * The tools on the pages read: every tool the server offers (0 when it has no tools
     * capability), unless `morePages` is set.
     */
    toolCount: z.int().nonnegative(),
    /**
     * The server still had pages after `MCP_TEST_MAX_PAGES`, which the test didn't read:
     * `toolCount` is then a lower bound ("more than N tools").
     */
    morePages: z.boolean(),
    /** The first `MCP_TEST_MAX_TOOLS` of them. */
    tools: z.array(McpTestTool).max(MCP_TEST_MAX_TOOLS),
  }),
  z.object({
    ok: z.literal(false),
    durationMs: z.int().nonnegative(),
    stage: McpTestStage,
    /** Why it failed, cut to `MCP_TEST_ERROR_LIMIT` characters. */
    error: z.string().max(MCP_TEST_ERROR_LIMIT),
    /** The test ran out of time (the server was stopped). */
    timedOut: z.boolean(),
    /** The end of a stdio server's stderr, when it wrote any. */
    stderrTail: z.string().max(MCP_TEST_STDERR_LIMIT).optional(),
    /**
     * What may explain the failure beyond the error itself, such as the provider giving a
     * stdio server only some of the environment (`McpStdioEnv` `allowlist`).
     */
    note: z.string().max(MCP_TEST_ERROR_LIMIT).optional(),
  }),
]);
export type McpServerTestResult = z.infer<typeof McpServerTestResult>;
