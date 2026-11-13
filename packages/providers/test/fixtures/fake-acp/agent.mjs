// A scripted stand-in for an ACP agent (`agent acp`, protocol version 1) and the Cursor CLI
// commands detection runs. No model is ever called.
//   agent.mjs --version        prints FAKE_ACP_VERSION (default 2026.10.22-abc1234)
//   agent.mjs status           prints FAKE_ACP_STATUS (default "Logged in as dev@example.com")
//   agent.mjs --list-models    prints a model list
//   agent.mjs acp              serves ACP on stdio; FAKE_ACP_NO_ACP=1 fails like an old CLI
// FAKE_ACP_LOG: every message the client sends, and every answer to the agent's requests
// (`{ method: "answer:<method>", params }`), one JSON line each.
// FAKE_ACP_SCRIPT: a JSON file of steps each `session/prompt` runs in order:
//   { "update": {...}, "session"? }       a session/update notification (`session`: a child's id)
//   { "request": "<method>", "params" }   an agent request, waiting for the client's answer
//                                         (`params.sessionId` sends it from a child session)
//   { "notify": "<method>", "params" }    an agent notification
//   { "hang": true }                      wait for session/cancel (the prompt then ends cancelled)
//   { "stopReason": "...", "usage": {} }  how the prompt ends (default end_turn)
// FAKE_ACP_LOAD=fail makes session/load fail; otherwise it replays a short history first,
// a subagent's child session included.
// Subagents: a client that opts in (`clientCapabilities.subagents` or `_meta.subagents`) gets
// `sessionCapabilities.subagents` back, as Cursor 2026.09.15+ does; FAKE_ACP_SUBAGENTS=0 acts
// like an older CLI that never reports it.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.FAKE_ACP_LOG;
const record = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  console.log(process.env.FAKE_ACP_VERSION ?? "2026.10.22-abc1234");
  process.exit(0);
}
if (args[0] === "status") {
  console.log(process.env.FAKE_ACP_STATUS ?? "Logged in as dev@example.com");
  process.exit(0);
}
if (args[0] === "--list-models") {
  console.log("Available models\n\nauto - Auto (current)\ngpt-5 - GPT-5\nsonnet-4.5 - Claude 4.5 Sonnet");
  process.exit(0);
}
if (args[0] !== "acp" || process.env.FAKE_ACP_NO_ACP === "1") {
  console.error(`error: unknown command '${args[0] ?? ""}'`);
  process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const script = process.env.FAKE_ACP_SCRIPT
  ? JSON.parse(readFileSync(process.env.FAKE_ACP_SCRIPT, "utf8"))
  : [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }];
const waiting = new Map();
let nextId = 1000;
let session = "sess-1";
let cancel = () => {};

const modelOption = (current = "auto") => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: current,
  options: [
    { value: "auto", name: "Auto" },
    { value: "gpt-5", name: "GPT-5" },
    { value: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
  ],
});
const modes = {
  currentModeId: "agent",
  availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
};

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

const update = (u, sessionId = session) =>
  send({ method: "session/update", params: { sessionId, update: u } });

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
    if (step.update) update(step.update, step.session);
    else if (step.notify) send({ method: step.notify, params: { sessionId: session, ...step.params } });
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
    case "initialize": {
      const caps = msg.params?.clientCapabilities ?? {};
      const subagents =
        process.env.FAKE_ACP_SUBAGENTS !== "0" && !!(caps.subagents || caps._meta?.subagents);
      return send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            mcpCapabilities: { http: true },
            sessionCapabilities: { list: {}, ...(subagents ? { subagents: {} } : {}) },
          },
          authMethods: [{ id: "cursor_login", name: "Cursor" }],
        },
      });
    }
    case "session/new":
      return send({ id: msg.id, result: { sessionId: session, modes, configOptions: [modelOption()] } });
    case "session/load":
      if (process.env.FAKE_ACP_LOAD === "fail") {
        return send({ id: msg.id, error: { code: -32002, message: "Session not found" } });
      }
      session = msg.params.sessionId;
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
      // An old subagent's run, child session included: history, never news.
      update({ sessionUpdate: "subagent_spawned", subagentSessionId: "sub-old", name: "Old task" });
      update(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old child" } },
        "sub-old",
      );
      update({ sessionUpdate: "subagent_state_update", subagentSessionId: "sub-old", state: "completed" });
      // The replay includes the mode the old session ended in.
      update({ sessionUpdate: "current_mode_update", currentModeId: "agent" });
      return send({ id: msg.id, result: { modes, configOptions: [modelOption()] } });
    case "session/set_mode":
      send({ id: msg.id, result: {} });
      return update({ sessionUpdate: "current_mode_update", currentModeId: msg.params.modeId });
    case "session/set_config_option":
      return send({ id: msg.id, result: { configOptions: [modelOption(msg.params.value)] } });
    case "session/prompt":
      return void prompt(msg);
    case "session/cancel":
      return cancel();
    case "cursor/list_available_models":
      return send({
        id: msg.id,
        result: { models: [{ modelId: "gpt-5", displayName: "GPT-5" }, { modelId: "sonnet-4.5" }] },
      });
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
