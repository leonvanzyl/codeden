// A stand-in for `opencode` (v2): `--version`, and `serve --stdio` with the slice of the v2 HTTP
// API CodeDen uses. Turns are scripted by a keyword in the prompt text (see SCRIPTS). Requests
// are logged to FAKE_OPENCODE_LOG (one JSON line each, with the env CodeDen passed); sessions
// persist to FAKE_OPENCODE_STATE so a new process can resume them.
// FAKE_OPENCODE_MODE: "no-providers" (nothing configured), "models-error" (`/api/model` 500),
// "v1" (`--version` reports 1.19.5), "hang" (never prints its URL), "no-archive" (PATCH
// rejects `archived`, like an OpenCode without archiving).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const mode = process.env.FAKE_OPENCODE_MODE ?? "";
const logFile = process.env.FAKE_OPENCODE_LOG;
const stateFile = process.env.FAKE_OPENCODE_STATE;
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (args.includes("--version")) {
  process.stdout.write(mode === "v1" ? "1.19.5\n" : "opencode v2.2.7\n");
  process.exit(0);
}
if (args[0] !== "serve") {
  process.stderr.write(`unsupported: ${args.join(" ")}\n`);
  process.exit(2);
}

const password = process.env.OPENCODE_PASSWORD;
let config = {};
try {
  config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
} catch {}
log({
  kind: "start",
  args,
  cwd: process.cwd(),
  config,
  hasPassword: !!password,
  electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
  extraEnv: process.env.CODEDEN_TEST_EXTRA ?? null,
});

const sessions = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => stateFile && writeFileSync(stateFile, JSON.stringify(sessions));
const clients = new Set();
const waiters = new Map(); // permission/form id -> resolve(reply)
const running = new Map(); // session id -> { interrupted, steers: [] }
let seq = 0;
const id = (p) => `${p}_${process.pid}_${++seq}`;
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } };

function emit(type, data) {
  const line = `data: ${JSON.stringify({ id: id("evt"), type, data })}\n\n`;
  for (const res of clients) res.write(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Costs are USD per million tokens: the base price, then context tiers.
const price = (input, output, tier) => ({ ...(tier ? { tier: { type: "context", size: tier } } : {}), input, output, cache: { read: input / 10, write: input * 1.25 } });
const MODELS = [
  {
    id: "claude-opus-5-5",
    providerID: "anthropic",
    name: "Claude Opus 5.5",
    variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
    limit: { context: 200000 },
    capabilities: { tools: true },
    cost: [price(5, 25), price(10, 37.5, 200000)],
  },
  { id: "claude-haiku-5-5", providerID: "anthropic", name: "Claude Haiku 5.5", cost: [price(0.01, 0.01, 200000), price(1, 5)] },
  { id: "claude-retired", providerID: "anthropic", name: "Retired", status: "deprecated", cost: [price(0.1, 0.1)] },
  { id: "gpt-5.5", providerID: "openai", name: "GPT-5.5", variants: [{ id: "none" }, { id: "medium" }], cost: [price(0.05, 0.4)] },
  { id: "old", providerID: "openai", name: "Old", status: "deprecated" },
  { id: "no-tools", providerID: "openai", name: "No tools", capabilities: { tools: false } },
  { id: "openai/gpt-oss-20b", providerID: "lmstudio", name: "GPT OSS 20B" },
];

async function permission(sid, action, resources, callId, metadata) {
  const pid = id("per");
  const reply = new Promise((resolve) => waiters.set(pid, resolve));
  emit("permission.asked", {
    id: pid,
    sessionID: sid,
    action,
    resources,
    save: ["*"],
    ...(metadata ? { metadata } : {}),
    source: { type: "tool", messageID: "msg", id: callId },
  });
  return reply;
}

async function tool(sid, msg, name, input, run) {
  const callId = id("call");
  emit("session.tool.input.started", { sessionID: sid, assistantMessageID: msg, id: callId, name });
  emit("session.tool.called", { sessionID: sid, assistantMessageID: msg, id: callId, input, executed: false });
  const result = await run(callId);
  if (result.error) {
    emit("session.tool.failed", { sessionID: sid, assistantMessageID: msg, id: callId, error: result.error, executed: false });
  } else {
    emit("session.tool.success", {
      sessionID: sid,
      assistantMessageID: msg,
      id: callId,
      content: [{ type: "text", text: result.text ?? "" }],
      metadata: result.metadata ?? {},
      executed: false,
    });
  }
  return result;
}

/** A permission-gated tool: the reply decides success or a rejection. */
const gated = (sid, action, resources, metadata, text, extra) => async (callId) => {
  const reply = await permission(sid, action, resources, callId, metadata);
  if (reply.decision === "reject") {
    return { error: { type: reply.message ? "permission.rejected" : "aborted", message: reply.message ?? "declined" } };
  }
  return { text, ...extra };
};

function say(sid, msg, text, ordinal = 0) {
  emit("session.text.started", { sessionID: sid, assistantMessageID: msg, ordinal });
  emit("session.text.delta", { sessionID: sid, assistantMessageID: msg, ordinal, delta: text });
  emit("session.text.ended", { sessionID: sid, assistantMessageID: msg, ordinal, text });
}

const SCRIPTS = {
  async hello(sid, msg) {
    emit("session.reasoning.started", { sessionID: sid, assistantMessageID: msg, ordinal: 0 });
    emit("session.reasoning.delta", { sessionID: sid, assistantMessageID: msg, ordinal: 0, delta: "Thinking. " });
    emit("session.reasoning.ended", { sessionID: sid, assistantMessageID: msg, ordinal: 0, text: "Thinking. " });
    say(sid, msg, "Hello from fake OpenCode.");
  },
  async edit(sid, msg) {
    const files = [{ file: "a.txt", patch: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hello\n+hello edited\n", status: "modified", additions: 1, deletions: 1 }];
    await tool(sid, msg, "edit", { path: "a.txt", oldString: "hello", newString: "hello edited" }, gated(sid, "edit", ["a.txt"], { files }, "Edited a.txt", { metadata: { files } }));
    say(sid, msg, "Edit done.", 1);
  },
  async shell(sid, msg) {
    const command = "pnpm test";
    await tool(sid, msg, "shell", { command, description: "Run tests" }, gated(sid, "shell", [command], undefined, "all passed", { metadata: { exit: 0 } }));
    say(sid, msg, "Shell done.", 1);
  },
  async push(sid, msg) {
    const command = "git push --force origin main";
    await tool(sid, msg, "shell", { command }, gated(sid, "shell", [command], undefined, "pushed", { metadata: { exit: 0 } }));
    say(sid, msg, "Push done.", 1);
  },
  async ask(sid, msg) {
    await tool(sid, msg, "question", { questions: [{ question: "Which colour?" }] }, async (callId) => {
      const fid = id("frm");
      const answer = new Promise((resolve) => waiters.set(fid, resolve));
      emit("form.created", {
        form: {
          id: fid,
          sessionID: sid,
          title: "Questions",
          metadata: { kind: "question", tool: { messageID: msg, id: callId } },
          fields: [
            { key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }], custom: true },
            { key: "q1", title: "Sizes", description: "Which sizes?", type: "multiselect", options: [{ value: "s", label: "Small" }, { value: "l", label: "Large" }] },
          ],
        },
      });
      const reply = await answer;
      if (reply.cancelled) return { error: { type: "aborted", message: "cancelled" } };
      return { text: `answers: ${JSON.stringify(reply.answer)}` };
    });
    say(sid, msg, "Asked.", 1);
  },
  async todo(sid, msg) {
    await tool(sid, msg, "todowrite", { todos: [{ content: "First", status: "in_progress" }, { content: "Second", status: "pending" }] }, async () => ({ text: "ok" }));
    say(sid, msg, "Planned.", 1);
  },
  async mcp(sid, msg) {
    const server = Object.keys(config.mcp?.servers ?? {})[0] ?? "codeden";
    await tool(sid, msg, `${server}_finish`, { summary: "done" }, async () => ({ text: "finished" }));
    say(sid, msg, "Called MCP.", 1);
  },
  async subagent(sid, msg) {
    await tool(sid, msg, "subagent", { agent: "explore", description: "Look around", prompt: "list files" }, async (callId) => {
      const child = id("ses");
      sessions[child] = { id: child, parentID: sid, location: sessions[sid].location };
      emit("session.created", { sessionID: child, parentID: sid, title: "Look around" });
      emit("session.tool.progress", { sessionID: sid, assistantMessageID: msg, id: callId, metadata: { sessionID: child, status: "running" } });
      emit("session.execution.started", { sessionID: child });
      emit("session.step.started", { sessionID: child, assistantMessageID: "child-msg", model: { providerID: "anthropic", id: "claude-opus-5-5" } });
      say(child, "child-msg", "Found 3 files.");
      emit("session.step.ended", { sessionID: child, assistantMessageID: "child-msg", finish: "stop", cost: 0.001, tokens });
      emit("session.execution.succeeded", { sessionID: child });
      return { text: `<subagent sessionID="${child}" state="completed">\nFound 3 files.\n</subagent>`, metadata: { sessionID: child } };
    });
    say(sid, msg, "Delegated.", 1);
  },
  async slow(sid, msg) {
    emit("session.text.started", { sessionID: sid, assistantMessageID: msg, ordinal: 0 });
    const run = running.get(sid);
    for (let i = 0; i < 300 && !run.interrupted; i++) {
      emit("session.text.delta", { sessionID: sid, assistantMessageID: msg, ordinal: 0, delta: "." });
      await sleep(20);
      if (run.steers.length) {
        const steer = run.steers.shift();
        emit("session.text.ended", { sessionID: sid, assistantMessageID: msg, ordinal: 0, text: "..." });
        say(sid, `${msg}-steer`, `steered: ${steer}`);
        return;
      }
    }
    if (run.interrupted) throw Object.assign(new Error("interrupted"), { interrupted: true });
  },
  async fail(sid) {
    throw Object.assign(new Error("boom"), { opencode: { type: "provider.auth", message: "Invalid API key", status: 401 } });
  },
  async retry(sid, msg) {
    emit("session.retry.scheduled", { sessionID: sid, assistantMessageID: msg, attempt: 1, at: Date.now(), error: { type: "provider.overloaded", message: "Overloaded" } });
    say(sid, msg, "Recovered.");
  },
  async crash() {
    setTimeout(() => process.exit(3), 30);
    await sleep(1000);
  },
};

async function execute(sid, text) {
  const run = { interrupted: false, steers: [] };
  running.set(sid, run);
  emit("session.execution.started", { sessionID: sid });
  const msg = id("msg");
  const s = sessions[sid];
  emit("session.step.started", { sessionID: sid, assistantMessageID: msg, model: s.model ?? { providerID: "anthropic", id: "claude-opus-5-5" } });
  const key = Object.keys(SCRIPTS).find((k) => text.toLowerCase().includes(k)) ?? "hello";
  try {
    await SCRIPTS[key](sid, msg);
    emit("session.step.ended", { sessionID: sid, assistantMessageID: msg, finish: "stop", cost: 0.0025, tokens });
    emit("session.execution.succeeded", { sessionID: sid });
  } catch (error) {
    if (error.interrupted) {
      emit("session.step.failed", { sessionID: sid, assistantMessageID: msg, error: { type: "aborted", message: "Step interrupted" } });
      emit("session.execution.interrupted", { sessionID: sid, reason: "user" });
    } else {
      emit("session.execution.failed", { sessionID: sid, error: error.opencode ?? { type: "unknown", message: error.message } });
    }
  } finally {
    running.delete(sid);
    s.history = [...(s.history ?? []), text];
    save();
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = createServer((req, res) => {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  if (!password || req.headers.authorization !== expected) return send(res, 401, { message: "Unauthorized" });
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    log({ kind: "request", method: req.method, path, body });
    const m = (re) => re.exec(path);
    let p;
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/info") return send(res, 200, { version: "2.2.7", pid: process.pid });
    if (path === "/api/provider") {
      return send(res, 200, { data: mode === "no-providers" ? [] : [{ id: "anthropic", name: "Anthropic" }, { id: "openai", name: "OpenAI" }, { id: "lmstudio", name: "LM Studio" }] });
    }
    if (path === "/api/credential") {
      return send(res, 200, { data: mode === "no-providers" ? [] : [{ id: "c1", integrationID: "anthropic", active: true }, { id: "c2", integrationID: "openai", active: false }] });
    }
    if (path === "/api/model") return mode === "models-error" ? send(res, 500, { message: "models down" }) : send(res, 200, { data: mode === "no-providers" ? [] : MODELS });
    if (path === "/api/model/default") return send(res, 200, { data: mode === "no-providers" ? null : MODELS[0] });
    if (path === "/api/mcp") return send(res, 200, { data: [{ name: "playwright", status: "connected" }, ...Object.keys(config.mcp?.servers ?? {}).map((name) => ({ name, status: "connected" }))] });
    if (path === "/api/experimental/generate/text") return send(res, 200, { data: { text: ` echo: ${body.prompt} via ${body.model ? `${body.model.providerID}/${body.model.id}` : "default"} ` } });
    if (path === "/api/session" && req.method === "POST") {
      const sid = id("ses");
      sessions[sid] = { id: sid, ...body, cost: 0, tokens };
      save();
      emit("session.created", { sessionID: sid, title: body.title });
      return send(res, 200, { data: sessions[sid] });
    }
    if ((p = m(/^\/api\/session\/([^/]+)$/))) {
      const s = sessions[decodeURIComponent(p[1])];
      if (!s) return send(res, 404, { _tag: "SessionNotFoundError", message: "Session not found" });
      if (req.method === "PATCH" && mode === "no-archive" && "archived" in body) {
        return send(res, 400, { _tag: "InvalidRequestError", message: "Unexpected key archived", kind: "Payload" });
      }
      if (req.method === "PATCH") {
        const { archived, ...rest } = body;
        Object.assign(s, rest);
        if (archived !== undefined) s.time = { ...(s.time ?? {}), ...(archived ? { archived: Date.now() } : { archived: undefined }) };
      }
      save();
      return send(res, 200, { data: s });
    }
    if ((p = m(/^\/api\/session\/([^/]+)\/model$/))) {
      const s = sessions[decodeURIComponent(p[1])];
      s.model = body.model;
      save();
      emit("session.model.selected", { sessionID: s.id, model: body.model });
      return send(res, 204);
    }
    if ((p = m(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/))) {
      const s = sessions[decodeURIComponent(p[1])];
      s.instructions = { ...(s.instructions ?? {}), [p[2]]: body.value };
      save();
      return send(res, 204);
    }
    if ((p = m(/^\/api\/session\/([^/]+)\/prompt$/))) {
      const sid = decodeURIComponent(p[1]);
      if (!sessions[sid]) return send(res, 404, { message: "Session not found" });
      const run = running.get(sid);
      if (run && body.delivery === "steer") run.steers.push(body.text);
      else setTimeout(() => execute(sid, body.text), 5);
      return send(res, 200, { data: { id: id("msg"), sessionID: sid, type: "user", delivery: body.delivery ?? "steer" } });
    }
    if ((p = m(/^\/api\/session\/([^/]+)\/interrupt$/))) {
      const run = running.get(decodeURIComponent(p[1]));
      if (run) run.interrupted = true;
      for (const [key, resolve] of waiters) {
        waiters.delete(key);
        resolve({ decision: "reject", cancelled: true });
      }
      return send(res, 200, { interrupted: !!run });
    }
    if ((p = m(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
      const resolve = waiters.get(decodeURIComponent(p[2]));
      if (!resolve) return send(res, 404, { message: "Permission not found" });
      waiters.delete(decodeURIComponent(p[2]));
      resolve(body);
      emit("permission.replied", { sessionID: decodeURIComponent(p[1]), requestID: p[2], reply: body.decision });
      return send(res, 204);
    }
    if ((p = m(/^\/api\/session\/([^/]+)\/form\/([^/]+)(\/reply)?$/))) {
      const fid = decodeURIComponent(p[2]);
      const resolve = waiters.get(fid);
      if (!resolve) return send(res, 404, { message: "Form not found" });
      waiters.delete(fid);
      resolve(p[3] ? body : { cancelled: true });
      return send(res, 204);
    }
    return send(res, 404, { message: `no route ${req.method} ${path}` });
  });
});

if (mode !== "hang") {
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })}\n`);
  });
}
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  log({ kind: "stdin-closed" });
  process.exit(0);
});
