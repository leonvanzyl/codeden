// A scripted stand-in for Gemini CLI's ACP server (`gemini --acp`, protocol version 1), in the
// shapes Gemini CLI 0.68 uses. No model is ever called.
//   gemini.mjs --version   prints FAKE_GEMINI_VERSION (default 0.68.0)
//   gemini.mjs --acp       serves ACP on stdio; FAKE_GEMINI_NO_ACP=1 fails like an old CLI
// Like Gemini CLI: sessions report `modes` (default, autoEdit, yolo, plan) and `models`, never
// config options; `session/set_mode` sends no `current_mode_update`.
// FAKE_GEMINI_MODE: the mode a session starts in (default "default", e.g. "yolo").
// FAKE_GEMINI_NO_PLAN=1: no `plan` mode. FAKE_GEMINI_AUTH=missing: `session/new` fails as
// signed out. FAKE_GEMINI_LOG: every message the client sends, and every answer to the agent's
// requests (`{ method: "answer:<method>", params }`), one JSON line each.
// FAKE_GEMINI_SCRIPT: a JSON file of steps each `session/prompt` runs in order:
//   { "update": {...} }                   a session/update notification
//   { "request": "<method>", "params" }   an agent request, waiting for the client's answer
//   { "hang": true }                      wait for session/cancel (the prompt then ends cancelled)
//   { "stopReason": "...", "usage": {} }  how the prompt ends (default end_turn)
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const record = (entry) => {
  if (env.FAKE_GEMINI_LOG) appendFileSync(env.FAKE_GEMINI_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  console.log(env.FAKE_GEMINI_VERSION ?? "0.68.0");
  process.exit(0);
}
if (args[0] !== "--acp" || env.FAKE_GEMINI_NO_ACP === "1") {
  console.error(`Unknown argument: ${args[0] ?? ""}`);
  process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const script = env.FAKE_GEMINI_SCRIPT
  ? JSON.parse(readFileSync(env.FAKE_GEMINI_SCRIPT, "utf8"))
  : [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }];
const waiting = new Map();
let nextId = 1000;
let session = "gem-1";
let cancel = () => {};

const setup = () => ({
  modes: {
    currentModeId: env.FAKE_GEMINI_MODE ?? "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "autoEdit", name: "Auto Edit" },
      { id: "yolo", name: "YOLO" },
      ...(env.FAKE_GEMINI_NO_PLAN === "1" ? [] : [{ id: "plan", name: "Plan" }]),
    ],
  },
  models: {
    currentModelId: "auto",
    availableModels: [
      { modelId: "auto", name: "Auto", description: "Let Gemini CLI decide" },
      { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
      { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
});

/** Send an agent request and wait for the answer. */
function ask(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, (answer) => {
      record({ method: `answer:${method}`, params: answer });
      resolve(answer);
    });
    send({ id, method, params: { sessionId: session, ...params } });
  });
}

const update = (u) => send({ method: "session/update", params: { sessionId: session, update: u } });

async function prompt(msg) {
  let cancelled = false;
  const hang = new Promise((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve();
    };
  });
  let end = { stopReason: "end_turn" };
  for (const step of script) {
    if (cancelled) break;
    if (step.update) update(step.update);
    else if (step.request) await ask(step.request, step.params ?? {});
    else if (step.hang) await hang;
    else if (step.stopReason) end = { stopReason: step.stopReason, ...(step.usage ? { usage: step.usage } : {}) };
  }
  send({ id: msg.id, result: cancelled ? { stopReason: "cancelled" } : end });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    return resolve?.(msg.result ?? { error: msg.error });
  }
  record({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.68.0" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: true, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
          },
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google" },
            { id: "gemini-api-key", name: "Gemini API key" },
            { id: "vertex-ai", name: "Vertex AI" },
            { id: "gateway", name: "AI API Gateway" },
          ],
        },
      });
    case "authenticate":
      // CodeDen must never send it: Gemini CLI would rewrite the user's login method.
      return send({ id: msg.id, error: { code: -32000, message: "authenticate is not expected" } });
    case "session/new":
      if (env.FAKE_GEMINI_AUTH === "missing") {
        return send({ id: msg.id, error: { code: -32000, message: "Authentication required." } });
      }
      return send({ id: msg.id, result: { sessionId: session, ...setup() } });
    case "session/load":
      session = msg.params.sessionId;
      // Gemini CLI 0.68 replays the history before it answers.
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
      return send({ id: msg.id, result: setup() });
    case "session/set_mode":
    case "session/set_model":
      return send({ id: msg.id, result: {} });
    case "session/prompt":
      return void prompt(msg);
    case "session/cancel":
      return cancel();
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
