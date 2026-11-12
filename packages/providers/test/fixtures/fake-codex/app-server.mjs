// Minimal `codex app-server` stand-in: answers the requests a session makes, records each
// request to FAKE_CODEX_LOG (one JSON line per request) and completes every turn at once.
// FAKE_CODEX_MODEL_LIST picks the `model/list` behaviour:
//   (unset)  two bare models, one page
//   "paged"  real-shaped models over two pages, with a hidden model and unknown efforts
//   "error"  a JSON-RPC error
//   "hang"   never answers `initialize`
// FAKE_CODEX_REQUESTS names a JSON file of server requests (`{ method, params }`) to send during
// every turn, one after the other (`notify: true` ones as notifications); each answer is logged as `{ method: "answer:<method>", params }`
// and the turn completes once all are answered.
// FAKE_CODEX_TURN=hang starts turns that never complete and never answers `turn/interrupt`.
// FAKE_CODEX_ECHO=1 echoes each turn/start and turn/steer input as a userMessage item.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_CODEX_LOG;
const mode = process.env.FAKE_CODEX_MODEL_LIST;
const turnMode = process.env.FAKE_CODEX_TURN;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turns = 0;
let nextRequestId = 9000;
const waiting = new Map();
const scripted = process.env.FAKE_CODEX_REQUESTS
  ? JSON.parse(readFileSync(process.env.FAKE_CODEX_REQUESTS, "utf8"))
  : [];

/** Send a server request and wait for the client's answer. */
function ask(method, params) {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    waiting.set(id, (result) => {
      if (log) appendFileSync(log, `${JSON.stringify({ method: `answer:${method}`, params: result })}
`);
      resolve(result);
    });
    send({ id, method, params });
  });
}

const efforts = (...names) => names.map((reasoningEffort) => ({ reasoningEffort, description: "" }));
const model = (slug, extra) => ({
  id: slug,
  model: slug,
  displayName: slug.toUpperCase(),
  description: `${slug} description`,
  hidden: false,
  supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra"),
  defaultReasoningEffort: "medium",
  isDefault: false,
  ...extra,
});
const PAGES = {
  first: {
    data: [
      model("gpt-sol", { isDefault: true, defaultReasoningEffort: "low" }),
      model("gpt-internal", { hidden: true }),
    ],
    nextCursor: "page-2",
  },
  "page-2": {
    data: [model("gpt-luna", { supportedReasoningEfforts: efforts("low", "medium") })],
    nextCursor: null,
  },
};

function modelList(msg) {
  if (mode === "error") return send({ id: msg.id, error: { code: -32603, message: "no models" } });
  if (mode === "paged") return send({ id: msg.id, result: PAGES[msg.params?.cursor ?? "first"] });
  return send({
    id: msg.id,
    result: {
      data: [
        { model: "gpt-other", displayName: "Other", isDefault: false, hidden: false },
        { model: "gpt-configured", displayName: "Configured", isDefault: true, hidden: false },
      ],
    },
  });
}

/**
 * FAKE_CODEX_ECHO=1: echo each input as a `userMessage` item, as the real server does, with the
 * request's `clientUserMessageId` as its `clientId`.
 */
function echoUserMessage(turnId, params) {
  if (process.env.FAKE_CODEX_ECHO !== "1") return;
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId,
      item: {
        type: "userMessage",
        id: `${turnId}-user-${++echoes}`,
        clientId: params.clientUserMessageId ?? null,
        content: params.input,
      },
    },
  });
}
let echoes = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    return resolve(msg.result ?? msg.error);
  }
  if (msg.id === undefined || !msg.method) return;
  if (log) appendFileSync(log, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
  switch (msg.method) {
    case "initialize":
      if (mode === "hang") return;
      return send({ id: msg.id, result: { userAgent: "fake-codex/0.0.0" } });
    case "thread/start":
    case "thread/resume":
      return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "gpt-configured" } });
    // A thread id of "missing" has nothing to fork, like a thread deleted from disk.
    case "thread/fork":
      if (msg.params?.threadId === "missing") {
        return send({ id: msg.id, error: { code: -32600, message: "thread not found" } });
      }
      return send({ id: msg.id, result: { thread: { id: "thread-fork-1" }, model: "gpt-configured" } });
    case "model/list":
      return modelList(msg);
    case "turn/start": {
      const turn = { id: `turn-${++turns}`, status: "completed", items: [], error: null };
      send({ id: msg.id, result: { turn: { ...turn, status: "inProgress" } } });
      echoUserMessage(turn.id, msg.params);
      if (turnMode === "hang") return;
      // Like the real server: the turn completes after the response has been handled.
      setTimeout(async () => {
        for (const [i, r] of scripted.entries()) {
          // `notify: true` entries are notifications (such as `item/started`), sent as they are.
          if (r.notify) {
            send({ method: r.method, params: { threadId: "thread-1", turnId: turn.id, ...r.params } });
            continue;
          }
          await ask(r.method, {
            threadId: "thread-1",
            turnId: turn.id,
            itemId: `${turn.id}-item-${i}`,
            startedAtMs: 1,
            environmentId: null,
            ...r.params,
          });
        }
        send({ method: "turn/completed", params: { threadId: "thread-1", turn } });
      }, 50);
      return;
    }
    case "turn/steer":
      send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
      return echoUserMessage(msg.params.expectedTurnId, msg.params);
    case "turn/interrupt":
      if (turnMode === "hang") return;
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, result: {} });
  }
});
