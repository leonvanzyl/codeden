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
// FAKE_CODEX_TURN=fail refuses `turn/start`; FAKE_CODEX_TURN=exit starts the turn, then the
// process exits mid-turn (a crash).
// FAKE_CODEX_TURN=open sends the scripted requests but keeps the turn open until
// `turn/interrupt`, which ends it as interrupted; interrupts for other threads (sub-agents) are
// answered but their turns never end. Scripted entries with `afterInterrupt: true` are held
// back and sent as notifications once the root turn has been interrupted.
// FAKE_CODEX_ECHO=1 echoes each turn/start and turn/steer input as a userMessage item.
// FAKE_CODEX_ARCHIVE names a JSON file holding the ids of archived threads (an array; a missing
// file is none), shared by every app-server process of a test like Codex's own archive folder.
// thread/archive and thread/unarchive answer as Codex 0.160 does, and an archived thread can't
// be resumed, forked or given a turn until it is unarchived. Without it, nothing stays archived.
// FAKE_CODEX_ARCHIVE_DELAY_MS makes thread/archive take that long (a loaded machine): the thread
// is archived, then the answer sent, once it has passed.
// FAKE_CODEX_TURN=lost answers every turn/start with Codex's "thread not found", as for a thread
// the app-server has unloaded, even right after a resume.
// FAKE_CODEX_THREADS names a JSON file of the threads in the Codex home (`{ id, preview }`):
// thread/list returns those not archived, two per page.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const archiveFile = process.env.FAKE_CODEX_ARCHIVE;
const archived = () =>
  archiveFile && existsSync(archiveFile) ? new Set(JSON.parse(readFileSync(archiveFile, "utf8"))) : new Set();
const saveArchived = (ids) => archiveFile && writeFileSync(archiveFile, JSON.stringify([...ids]));
const fail = (msg, message) => send({ id: msg.id, error: { code: -32600, message } });
/** Codex 0.160's refusal to resume or fork an archived thread. */
const isArchived = (msg, threadId) => {
  if (!archived().has(threadId)) return false;
  fail(msg, `session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`);
  return true;
};

/** thread/archive and thread/unarchive (without FAKE_CODEX_ARCHIVE, nothing stays archived). */
function archiveRequest(msg) {
  const threadId = msg.params?.threadId;
  const ids = archived();
  if (msg.method === "thread/archive") {
    if (threadId === "missing") return fail(msg, `no rollout found for thread id ${threadId}`);
    const delay = Number(process.env.FAKE_CODEX_ARCHIVE_DELAY_MS ?? 0);
    const done = () => {
      const now = archived();
      now.add(threadId);
      saveArchived(now);
      send({ id: msg.id, result: {} });
    };
    if (delay > 0) return setTimeout(done, delay);
    return done();
  }
  if (!ids.has(threadId)) return fail(msg, `no archived rollout found for thread id ${threadId}`);
  ids.delete(threadId);
  saveArchived(ids);
  return send({ id: msg.id, result: { thread: { id: threadId } } });
}

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
      return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "gpt-configured" } });
    case "thread/resume":
      if (isArchived(msg, msg.params?.threadId)) return;
      return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "gpt-configured" } });
    case "thread/archive":
    case "thread/unarchive":
      return archiveRequest(msg);
    case "thread/list": {
      const file = process.env.FAKE_CODEX_THREADS;
      const all = file ? JSON.parse(readFileSync(file, "utf8")) : [];
      const hidden = archived();
      const listed = all.filter((t) => !hidden.has(t.id));
      const from = Number(msg.params?.cursor ?? 0);
      const data = listed
        .slice(from, from + 2)
        .map((t) => ({ name: null, updatedAt: 1794650000, ...t, source: "vscode" }));
      const nextCursor = from + 2 < listed.length ? String(from + 2) : null;
      return send({ id: msg.id, result: { data, nextCursor, backwardsCursor: null } });
    }
    // "thread-source" holds turn-1 to turn-3, listed two per page (newest first); "old-codex"
    // stands for an app-server without the method. Any other thread answers like Codex 0.160
    // does for a thread a short-lived app-server hasn't loaded.
    case "thread/turns/list": {
      const threadId = msg.params?.threadId;
      if (threadId === "old-codex") {
        return send({ id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (threadId !== "thread-source") {
        return send({ id: msg.id, error: { code: -32600, message: `thread not loaded: ${threadId}` } });
      }
      const all = ["turn-3", "turn-2", "turn-1"];
      const from = Number(msg.params?.cursor ?? 0);
      const data = all.slice(from, from + 2).map((id) => ({ id, items: [], status: "completed" }));
      const next = from + 2 < all.length ? String(from + 2) : null;
      return send({ id: msg.id, result: { data, nextCursor: next, backwardsCursor: null } });
    }
    // Codex 0.160's answers: "missing" is a thread deleted from disk, "turn-gone" a turn the
    // thread doesn't hold, "turn-running" a turn still in progress.
    case "thread/fork": {
      const { threadId, lastTurnId } = msg.params ?? {};
      if (threadId === "missing") return fail(msg, `no rollout found for thread id ${threadId}`);
      if (isArchived(msg, threadId)) return;
      if (lastTurnId === "turn-gone") return fail(msg, `turn not found: ${lastTurnId}`);
      if (lastTurnId === "turn-running") {
        return fail(msg, `lastTurnId '${lastTurnId}' identifies an in-progress turn`);
      }
      return send({ id: msg.id, result: { thread: { id: "thread-fork-1" }, model: "gpt-configured" } });
    }
    case "model/list":
      return modelList(msg);
    case "turn/start": {
      // Archiving unloads a thread: a turn on it fails until it is unarchived and resumed.
      if (archived().has(msg.params?.threadId) || turnMode === "lost") {
        return fail(msg, `thread not found: ${msg.params.threadId}`);
      }
      if (turnMode === "fail") return fail(msg, "turn refused");
      const turn = { id: `turn-${++turns}`, status: "completed", items: [], error: null };
      send({ id: msg.id, result: { turn: { ...turn, status: "inProgress" } } });
      echoUserMessage(turn.id, msg.params);
      if (turnMode === "hang") return;
      if (turnMode === "exit") return setTimeout(() => process.exit(3), 50);
      // Like the real server: the turn completes after the response has been handled.
      setTimeout(async () => {
        for (const [i, r] of scripted.entries()) {
          if (r.afterInterrupt) continue;
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
        if (turnMode !== "open") send({ method: "turn/completed", params: { threadId: "thread-1", turn } });
      }, 50);
      return;
    }
    case "turn/steer":
      send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
      return echoUserMessage(msg.params.expectedTurnId, msg.params);
    case "turn/interrupt":
      if (turnMode === "hang") return;
      send({ id: msg.id, result: {} });
      if (turnMode === "open" && msg.params?.threadId === "thread-1") {
        const turn = { id: msg.params.turnId, status: "interrupted", items: [], error: null };
        send({ method: "turn/completed", params: { threadId: "thread-1", turn } });
        for (const r of scripted.filter((entry) => entry.afterInterrupt)) {
          send({ method: r.method, params: { threadId: "thread-1", turnId: turn.id, ...r.params } });
        }
      }
      return;
    default:
      return send({ id: msg.id, result: {} });
  }
});
