import { type BrowserTab, MAX_FOCUS_TYPE_CHARS } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../define";

/**
 * Agent browser tools (§12.2): agents drive the same session browser the user watches in the
 * panel. Every call acts on the caller's own session (taken from its MCP token), never on a
 * session named in the input.
 */

const tabId = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe("Tab id (t1, t2, ...); default: the active tab");
const ref = z
  .string()
  .regex(/^(f\d+)?e\d+$/, "An element ref from browser_snapshot, e.g. e12")
  .describe("Element ref from the latest browser_snapshot, e.g. e12");

function tabLine(tabs: BrowserTab[]): string {
  return tabs
    .map((t) => `${t.active ? "*" : " "} ${t.tabId} ${t.title || "(untitled)"} - ${t.url}`)
    .join("\n");
}

export const browserNavigate = defineTool({
  name: "browser_navigate",
  description:
    "Open a URL in your session's browser (the same browser the user sees in CodeDen's browser panel). Opens the browser on first use. Bare host:port gets http://. Follow with browser_snapshot to read the page.",
  roles: ["agent"],
  scope: "session",
  input: z.object({ url: z.string().min(1).max(8_000), tabId }),
  handler: async (input, { services, sessionId }) => {
    const result = await services.browser.agentNavigate(sessionId, input.url, input.tabId);
    const { tabs } = await services.browser.tabs(sessionId);
    const status = result.status ? ` (HTTP ${result.status})` : "";
    return `Navigated to ${result.url ?? input.url}${status}.\nTabs:\n${tabLine(tabs)}`;
  },
});

export const browserSnapshot = defineTool({
  name: "browser_snapshot",
  description:
    "Accessibility snapshot of the page as YAML, with element refs (e12) to use in browser_click and browser_type. Take a new snapshot after the page changes.",
  roles: ["agent"],
  scope: "session",
  input: z.object({ tabId }),
  handler: async (input, { services, sessionId }) => {
    const snap = await services.browser.agentCommand({
      name: "browser.snapshot",
      sessionId,
      tabId: input.tabId,
    });
    const note = snap.truncated ? "\n(snapshot truncated)" : "";
    return `Tab ${snap.tabId}: ${snap.title} - ${snap.url}\n\n${snap.snapshot}${note}`;
  },
});

export const browserClick = defineTool({
  name: "browser_click",
  description:
    "Click an element by its ref from browser_snapshot. For things without a useful ref (canvas, map, drag handle), click at screenshot coordinates with browser_mouse.",
  roles: ["agent"],
  scope: "session",
  input: z.object({
    ref,
    button: z.enum(["left", "middle", "right"]).optional(),
    doubleClick: z.boolean().optional(),
    tabId,
  }),
  handler: async (input, { services, sessionId }) => {
    await services.browser.agentCommand({ name: "browser.click", sessionId, ...input });
    return `Clicked ${input.ref}.`;
  },
});

export const browserType = defineTool({
  name: "browser_type",
  description: `Fill an editable element (input, textarea, contenteditable) by ref, replacing its value. Without a ref, types the text as key presses into whatever has focus (at most ${MAX_FOCUS_TYPE_CHARS} characters), e.g. after clicking into a canvas editor with browser_mouse. \`submit: true\` presses Enter afterwards.`,
  roles: ["agent"],
  scope: "session",
  input: z
    .object({
      ref: ref.optional(),
      text: z.string().max(100_000),
      submit: z.boolean().optional(),
      tabId,
    })
    .refine((v) => v.ref !== undefined || v.text.length <= MAX_FOCUS_TYPE_CHARS, {
      message: `Without a ref, type at most ${MAX_FOCUS_TYPE_CHARS} characters`,
      path: ["text"],
    }),
  handler: async (input, { services, sessionId }) => {
    await services.browser.agentCommand({ name: "browser.type", sessionId, ...input });
    const where = input.ref ? `into ${input.ref}` : "at the focused element";
    return `Typed ${where}${input.submit ? " and pressed Enter" : ""}.`;
  },
});

export const browserPress = defineTool({
  name: "browser_press",
  description: "Press a key or chord on the focused element, e.g. Enter, Escape, Control+A.",
  roles: ["agent"],
  scope: "session",
  input: z.object({ key: z.string().min(1).max(60), tabId }),
  handler: async (input, { services, sessionId }) => {
    await services.browser.agentCommand({ name: "browser.press", sessionId, ...input });
    return `Pressed ${input.key}.`;
  },
});

export const browserLogs = defineTool({
  name: "browser_logs",
  description:
    "Console messages (including page errors) and network requests captured in your browser. Pass `since` (the last id you saw) to get only new entries.",
  roles: ["agent"],
  scope: "session",
  input: z.object({
    kind: z.enum(["console", "network", "all"]).optional(),
    since: z.int().nonnegative().optional(),
    limit: z.int().min(1).max(500).optional(),
    tabId,
  }),
  handler: async (input, { services, sessionId }) => {
    // Reads captured buffers only: not shown as the agent acting on the page.
    const logs = await services.browser.command({
      name: "browser.logs",
      sessionId,
      ...input,
      limit: input.limit ?? 100,
    });
    const lines: string[] = [];
    if (input.kind !== "network") {
      lines.push(`Console (${logs.console.length}):`);
      for (const e of logs.console) {
        const where = e.url ? ` (${e.url}${e.line !== undefined ? `:${e.line}` : ""})` : "";
        lines.push(`#${e.id} [${e.level}] ${e.text}${where}`);
      }
    }
    if (input.kind !== "console") {
      lines.push(`Network (${logs.network.length}):`);
      for (const e of logs.network) {
        const result = e.failure ?? (e.status === null ? "pending" : String(e.status));
        lines.push(`#${e.id} ${e.method} ${e.url} -> ${result} (${e.resourceType})`);
      }
    }
    return lines.join("\n");
  },
});

export const browserWait = defineTool({
  name: "browser_wait",
  description:
    "Wait until a CSS selector is visible, some text appears, or the network is idle (pass exactly one).",
  roles: ["agent"],
  scope: "session",
  input: z
    .object({
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      networkIdle: z.boolean().optional(),
      timeoutMs: z.int().min(1).max(60_000).optional(),
      tabId,
    })
    .refine((v) => [v.selector, v.text, v.networkIdle || undefined].filter(Boolean).length === 1, {
      message: "Pass exactly one of selector, text or networkIdle",
    }),
  handler: async (input, { services, sessionId }) => {
    const { matched } = await services.browser.agentCommand({
      name: "browser.wait",
      sessionId,
      ...input,
    });
    return matched ? "Matched." : "Timed out before it matched.";
  },
});

export const browserEvaluate = defineTool({
  name: "browser_evaluate",
  description:
    "Evaluate a JavaScript expression or function source in the page and return its JSON result. Use it to read page state that the snapshot does not show; prefer browser_click and browser_type for interaction. Runs with a 5 second timeout and a result size cap.",
  roles: ["agent"],
  scope: "session",
  input: z.object({ expression: z.string().min(1).max(20_000), tabId }),
  handler: async (input, { services, sessionId }) => {
    const result = await services.browser.agentCommand({
      name: "browser.evaluate",
      sessionId,
      ...input,
    });
    return result.truncated ? `${result.json}\n(result truncated)` : result.json;
  },
});

export const browserOpenDevServer = defineTool({
  name: "browser_open_dev_server",
  description:
    "Open a local dev server (http://localhost:<port>) in a new tab of your browser. Without a port, CodeDen looks for dev servers you started and opens the only one, or lists them.",
  roles: ["agent"],
  scope: "session",
  input: z.object({
    port: z.int().min(1).max(65535).optional(),
    path: z.string().startsWith("/").max(2_000).optional(),
  }),
  handler: async (input, { services, sessionId }) => {
    let port = input.port;
    if (port === undefined) {
      const servers = await services.browser.devServers();
      if (servers.length === 0) {
        throw new ToolError("No dev server found. Start one, then pass its port.");
      }
      if (servers.length > 1) {
        return `Several dev servers are running; call again with a port:\n${servers
          .map((s) => `- ${s.url}${s.pid ? ` (pid ${s.pid})` : ""}`)
          .join("\n")}`;
      }
      port = servers[0]?.port as number;
    }
    const { tab } = await services.browser.agentOpenDevServer(sessionId, port, input.path);
    return `Opened ${tab.url} in tab ${tab.tabId}. Use browser_snapshot to read it.`;
  },
});
