import { type BrowserClientMessage, BrowserServerMessage } from "@codeden/contracts";
import type { BrowserChannel, BrowserChannelOptions, BrowserConnection } from "./feature-apis";

const RECONNECT_MS = [500, 1_000, 2_000, 4_000];

/** `/ws/browser` query string from the channel options. */
export function browserSocketQuery(sessionId: string, opts: BrowserChannelOptions = {}): string {
  const params = new URLSearchParams({ sessionId });
  if (opts.open) params.set("open", "1");
  if (opts.native) params.set("native", "1");
  for (const key of ["quality", "maxWidth", "maxHeight", "maxFps"] as const) {
    const value = opts[key];
    if (value !== undefined) params.set(key, String(Math.round(value)));
  }
  return params.toString();
}

/**
 * One viewer of a session's browser over `/ws/browser` (§12.2). Server messages are validated
 * with the contract; control messages sent before the socket opens are queued (input is
 * dropped, it is only meaningful against the frame the user saw). Reconnects after drops.
 */
export function openBrowserSocket(
  wsBase: string,
  sessionId: string,
  opts: BrowserChannelOptions = {},
): BrowserChannel {
  const url = `${wsBase}/ws/browser?${browserSocketQuery(sessionId, opts)}`;
  const messages = new Set<(m: BrowserServerMessage) => void>();
  const states = new Set<(s: BrowserConnection) => void>();
  let pending: BrowserClientMessage[] = [];
  /** Latest panel size: the server forgets it with the socket, so it is sent on every open. */
  let viewport: Extract<BrowserClientMessage, { type: "viewport" }> | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let state: BrowserConnection = "connecting";

  const setState = (next: BrowserConnection) => {
    state = next;
    for (const l of states) l(next);
  };

  const connect = () => {
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      setState("open");
      // Without the claim: a reconnect is not the user picking this viewer.
      if (viewport) socket.send(JSON.stringify({ ...viewport, claim: undefined }));
      for (const msg of pending) socket.send(JSON.stringify(msg));
      pending = [];
    };
    socket.onmessage = (e) => {
      let parsed: BrowserServerMessage;
      try {
        parsed = BrowserServerMessage.parse(JSON.parse(String(e.data)));
      } catch {
        return;
      }
      for (const l of messages) l(parsed);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setState("closed");
      if (closed) return;
      const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 4_000;
      attempt += 1;
      setTimeout(() => {
        if (closed) return;
        setState("connecting");
        connect();
      }, wait);
    };
  };
  connect();

  /** Send now (true), or queue it (when `queue`) or drop it while disconnected (false). */
  const send = (msg: BrowserClientMessage, queue: boolean): boolean => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    if (queue) pending.push(msg);
    return false;
  };

  return {
    onMessage(listener) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onConnection(listener) {
      states.add(listener);
      listener(state);
      return () => states.delete(listener);
    },
    input: (input) => send({ type: "input", input }, false),
    watch: (settings) => send({ type: "watch", settings }, true),
    unwatch: () => send({ type: "unwatch" }, true),
    open: (target) => send({ type: "open", url: target }, true),
    viewport(size, claim) {
      viewport = { type: "viewport", ...size, ...(claim ? { claim: true } : {}) };
      // Not queued: the open handler sends the latest one.
      send(viewport, false);
    },
    dialog: (dialogId, accept, promptText) =>
      send(
        { type: "dialog", dialogId, accept, ...(promptText !== undefined && { promptText }) },
        false,
      ),
    close() {
      closed = true;
      const socket = ws;
      ws = null;
      socket?.close(1000);
      messages.clear();
      states.clear();
    },
  };
}
