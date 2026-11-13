import { randomUUID } from "node:crypto";
import {
  BrowserClientMessage,
  type BrowserDialog,
  type BrowserEngine,
  type BrowserScreencastSettings,
  type BrowserServerMessage,
  type BrowserTab,
  type BrowserWsQuery,
  type RunnerStream,
} from "@codeden/contracts";
import type { WSContext, WSEvents } from "hono/ws";
import { type BrowserService, isBrowserNotOpen } from "../services/browser/browser-service";
import { errorMessage, ServiceError } from "../services/errors";
import { runnerErrorCode } from "../services/runner-port";
import { ViewportArbiter } from "./browser-viewport";

interface AppliedViewport {
  key: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Native views follow the desktop panel: no viewer owns the size. */
  fixed: boolean;
}

/** Skip frames for a socket that has this much unsent data (slow client). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

interface Viewer {
  id: string;
  ws: WSContext;
  sessionId: string;
  /** The viewer wants frames (default true); it watches as soon as the browser is open. */
  wantsWatch: boolean;
  /** The desktop window, which shows native views itself (`native=1`). */
  native: boolean;
  /** Registered with the runner's screencast. */
  watching: boolean;
  open: boolean;
  settings: BrowserScreencastSettings;
  closed: boolean;
}

export interface BrowserBridgeDeps {
  browser: BrowserService;
  log?: (message: string) => void;
}

/**
 * The `/ws/browser` channel (§12.2): one socket is one viewer of one session's browser.
 * Relays the runner's `browser.frame`, `browser.tabs` and `browser.dialogs` stream data for that
 * session, forwards human input and dialog answers, and registers the viewer with the runner's
 * screencast, so the screencast runs only while somebody watches.
 */
export class BrowserBridge {
  private readonly viewers = new Map<string, Set<Viewer>>();
  /** Per session: whose panel size the page follows. */
  private readonly arbiters = new Map<string, ViewportArbiter>();
  /** Per session: the viewport the runner last applied (cleared when the browser closes). */
  private readonly applied = new Map<string, AppliedViewport>();
  private readonly applying = new Map<string, Promise<void>>();
  /** Per session: what backs its open browser. */
  private readonly engines = new Map<string, BrowserEngine>();
  /** Per session: page dialogs waiting for an answer (shown to viewers that connect later). */
  private readonly dialogs = new Map<string, BrowserDialog[]>();

  constructor(private readonly deps: BrowserBridgeDeps) {
    deps.browser.agentActivity?.onChange((sessionId, acting) => {
      for (const v of this.viewers.get(sessionId) ?? []) send(v.ws, { type: "agent", acting });
    });
  }

  handlers(query: BrowserWsQuery): WSEvents {
    let viewer: Viewer | undefined;
    return {
      onOpen: (_event, ws) => {
        const { sessionId, open: _open, native: nativeQuery, ...settings } = query;
        const native = nativeQuery === "1";
        viewer = {
          id: `ui-${randomUUID()}`,
          ws,
          sessionId,
          // The desktop window draws native views itself; it asks for frames only when the
          // session's browser is on the runner's Chromium.
          wantsWatch: !native,
          native,
          watching: false,
          open: false,
          settings,
          closed: false,
        };
        this.add(viewer);
        const v = viewer;
        void this.start(v, query.open === "1").catch((error: unknown) => this.fail(v, error));
      },
      onMessage: (event) => {
        if (!viewer) return;
        const v = viewer;
        let msg: BrowserClientMessage;
        try {
          msg = BrowserClientMessage.parse(JSON.parse(String(event.data)));
        } catch {
          return send(v.ws, { type: "error", code: "bad_message", message: "Invalid message" });
        }
        void this.handle(v, msg).catch((error: unknown) => this.fail(v, error));
      },
      onClose: () => {
        if (!viewer) return;
        viewer.closed = true;
        this.remove(viewer);
        if (viewer.watching) void this.setWatching(viewer, false).catch(() => undefined);
        // The owner left: the page follows the next viewer (or keeps its size if none).
        const arbiter = this.arbiters.get(viewer.sessionId);
        if (arbiter) {
          const owner = arbiter.ownerId;
          const resized = arbiter.remove(viewer.id);
          if (arbiter.viewers === 0) this.arbiters.delete(viewer.sessionId);
          else if (resized) this.applyViewport(viewer.sessionId);
          else if (owner !== arbiter.ownerId) this.announceViewport(viewer.sessionId);
        }
      },
    };
  }

  /** Runner stream data: frames, tab updates and page dialogs go to the session's viewers. */
  onStream(stream: RunnerStream): void {
    if (stream.kind === "browser.frame") {
      const { sessionId: _s, kind: _k, ...frame } = stream;
      for (const v of this.viewers.get(stream.sessionId) ?? []) {
        if (!v.watching || buffered(v.ws) > MAX_BUFFERED_BYTES) continue;
        send(v.ws, { type: "frame", ...frame });
      }
      return;
    }
    if (stream.kind === "browser.dialogs") {
      const { sessionId, kind: _k, ...update } = stream;
      this.noteDialogs(sessionId, update.dialogs);
      for (const v of this.viewers.get(sessionId) ?? []) send(v.ws, { type: "dialogs", ...update });
      return;
    }
    if (stream.kind === "browser.tabs") {
      const engineChanged =
        stream.engine !== undefined && this.engines.get(stream.sessionId) !== stream.engine;
      if (stream.engine) this.engines.set(stream.sessionId, stream.engine);
      if (stream.tabs.length === 0 || engineChanged) this.applied.delete(stream.sessionId);
      // A closed browser, or one moved to the runner's Chromium, has no dialogs open.
      if ((stream.tabs.length === 0 || engineChanged) && this.dialogs.delete(stream.sessionId)) {
        for (const v of this.viewers.get(stream.sessionId) ?? []) {
          send(v.ws, { type: "dialogs", dialogs: [] });
        }
      }
      for (const v of this.viewers.get(stream.sessionId) ?? []) {
        if (stream.tabs.length === 0) {
          if (v.open) this.detach(v);
          continue;
        }
        if (!v.open) {
          // The agent (or another viewer) just opened the browser: start watching.
          v.open = true;
          void this.watchIfWanted(v, stream.tabs).catch((error: unknown) => this.fail(v, error));
        } else {
          send(v.ws, { type: "tabs", tabs: stream.tabs, engine: this.engines.get(v.sessionId) });
          // Handed to the runner's Chromium: the page follows the panels' sizes again.
          if (engineChanged && stream.engine === "runner") this.applyViewport(v.sessionId);
        }
      }
    }
  }

  /** Number of viewers per session (diagnostics and tests). */
  viewerCount(sessionId: string): number {
    return this.viewers.get(sessionId)?.size ?? 0;
  }

  private async start(v: Viewer, openNow: boolean): Promise<void> {
    if (openNow) {
      const opened = await this.deps.browser.open(v.sessionId, undefined, { native: v.native });
      this.noteEngine(v.sessionId, opened.engine);
      v.open = true;
      return this.watchIfWanted(v, opened.tabs);
    }
    const { open, tabs, engine, dialogs } = await this.deps.browser.tabs(v.sessionId);
    this.noteEngine(v.sessionId, engine);
    if (open) this.noteDialogs(v.sessionId, dialogs ?? []);
    v.open = v.open || open;
    if (!v.open) return this.sendState(v, []);
    return this.watchIfWanted(v, tabs);
  }

  private async handle(v: Viewer, msg: BrowserClientMessage): Promise<void> {
    const { browser } = this.deps;
    switch (msg.type) {
      case "input":
        await browser.command({ name: "browser.input", sessionId: v.sessionId, input: msg.input });
        return;
      case "watch":
        v.wantsWatch = true;
        if (msg.settings) v.settings = { ...v.settings, ...msg.settings };
        if (v.open) await this.setWatching(v, true);
        return this.sendState(v, (await browser.tabs(v.sessionId)).tabs);
      case "unwatch":
        v.wantsWatch = false;
        if (v.watching) await this.setWatching(v, false);
        return this.sendState(v, (await browser.tabs(v.sessionId)).tabs);
      case "open": {
        const opened = await browser.open(v.sessionId, msg.url, { native: v.native });
        this.noteEngine(v.sessionId, opened.engine);
        v.open = true;
        return this.watchIfWanted(v, opened.tabs);
      }
      case "viewport": {
        const { type: _t, claim, ...size } = msg;
        let arbiter = this.arbiters.get(v.sessionId);
        if (!arbiter) {
          arbiter = new ViewportArbiter();
          this.arbiters.set(v.sessionId, arbiter);
        }
        const owner = arbiter.ownerId;
        if (arbiter.report(v.id, size, claim)) this.applyViewport(v.sessionId);
        else if (owner !== arbiter.ownerId) this.announceViewport(v.sessionId);
        return;
      }
      case "dialog": {
        const { type: _t, ...answer } = msg;
        try {
          await browser.command({
            name: "browser.dialog",
            sessionId: v.sessionId,
            ...answer,
            by: "viewer",
          });
        } catch (error) {
          // Somebody else (another viewer, the agent, the timeout) answered it first.
          if (runnerErrorCode(error) !== "no_dialog") throw error;
        }
        return;
      }
    }
  }

  private async watchIfWanted(v: Viewer, tabs: BrowserTab[]): Promise<void> {
    if (v.wantsWatch && !v.watching) await this.setWatching(v, true);
    this.sendState(v, tabs);
    const dialogs = this.dialogs.get(v.sessionId);
    if (dialogs) send(v.ws, { type: "dialogs", dialogs });
    if (v.open) {
      // A freshly opened browser (or a new server) gets the owner's size; otherwise tell this
      // viewer what the page is at.
      if (this.applied.has(v.sessionId)) this.announceViewport(v.sessionId, v);
      else this.applyViewport(v.sessionId);
    }
    if (this.deps.browser.agentActivity?.isActing(v.sessionId)) {
      send(v.ws, { type: "agent", acting: true });
    }
  }

  /**
   * Bring the runner's viewport in line with the owning viewer's panel. Serialized per session
   * and always applies the latest size, so a burst of resizes ends at the final one.
   */
  private applyViewport(sessionId: string): void {
    const run = async () => {
      const size = this.arbiters.get(sessionId)?.size;
      if (!size) return;
      const key = `${size.width}x${size.height}@${size.deviceScaleFactor}`;
      const known = this.applied.get(sessionId);
      // A fixed size changes with the desktop panel, not with reports: ask again every time.
      if (known?.key === key && !known.fixed) return this.announceViewport(sessionId);
      try {
        const result = await this.deps.browser.command({
          name: "browser.viewport",
          sessionId,
          width: Math.min(size.width, 7680),
          height: Math.min(size.height, 4320),
          deviceScaleFactor: size.deviceScaleFactor,
        });
        this.applied.set(sessionId, {
          key,
          width: result.width ?? size.width,
          height: result.height ?? size.height,
          deviceScaleFactor: result.deviceScaleFactor ?? size.deviceScaleFactor,
          fixed: result.fixed === true,
        });
        this.announceViewport(sessionId);
      } catch (error) {
        // Not open yet: applied when it opens.
        if (!isBrowserNotOpen(error)) this.deps.log?.(`browser viewport: ${errorMessage(error)}`);
      }
    };
    const next = (this.applying.get(sessionId) ?? Promise.resolve()).then(run, run);
    this.applying.set(sessionId, next);
    void next.finally(() => {
      if (this.applying.get(sessionId) === next) this.applying.delete(sessionId);
    });
  }

  /** Tell viewers (or one) the applied viewport and whether it follows their panel. */
  private announceViewport(sessionId: string, only?: Viewer): void {
    const applied = this.applied.get(sessionId);
    if (!applied) return;
    const owner = this.arbiters.get(sessionId)?.ownerId;
    const { key: _k, fixed, ...viewport } = applied;
    for (const v of only ? [only] : (this.viewers.get(sessionId) ?? [])) {
      if (v.open) send(v.ws, { type: "viewport", ...viewport, mine: !fixed && v.id === owner });
    }
  }

  private async setWatching(v: Viewer, watching: boolean): Promise<void> {
    const before = v.watching;
    // Set first: the runner replays the current frame to a new viewer before it answers, and
    // a static page sends nothing more, so that frame must not be dropped.
    v.watching = watching && !v.closed;
    try {
      await this.deps.browser.command({
        name: "browser.screencast",
        sessionId: v.sessionId,
        viewerId: v.id,
        watching: watching && !v.closed,
        ...v.settings,
      });
    } catch (error) {
      v.watching = before;
      if (!isBrowserNotOpen(error)) throw error;
      // The browser closed under us (session stopped): wait for it to open again.
      v.open = false;
      v.watching = false;
      this.sendState(v, []);
    }
  }

  /**
   * The session's browser closed (agent, panel, another viewer or session stop): its screencast
   * registrations went with it, so the viewer is detached and told with a closed `state`. It
   * stays connected and watches again when the browser next opens.
   */
  private detach(v: Viewer): void {
    v.open = false;
    v.watching = false;
    this.sendState(v, []);
  }

  private sendState(v: Viewer, tabs: BrowserTab[]): void {
    const engine = v.open ? this.engines.get(v.sessionId) : undefined;
    send(v.ws, { type: "state", viewerId: v.id, open: v.open, watching: v.watching, tabs, engine });
  }

  private noteEngine(sessionId: string, engine: BrowserEngine | undefined): void {
    if (engine) this.engines.set(sessionId, engine);
  }

  private noteDialogs(sessionId: string, dialogs: BrowserDialog[]): void {
    if (dialogs.length > 0) this.dialogs.set(sessionId, dialogs);
    else this.dialogs.delete(sessionId);
  }

  private fail(v: Viewer, error: unknown): void {
    const code = error instanceof ServiceError ? error.code : "browser_error";
    send(v.ws, { type: "error", code, message: errorMessage(error) });
  }

  private add(v: Viewer): void {
    const set = this.viewers.get(v.sessionId) ?? new Set();
    set.add(v);
    this.viewers.set(v.sessionId, set);
  }

  private remove(v: Viewer): void {
    const set = this.viewers.get(v.sessionId);
    set?.delete(v);
    if (set?.size === 0) this.viewers.delete(v.sessionId);
  }
}

function buffered(ws: WSContext): number {
  const raw = ws.raw as { bufferedAmount?: number } | undefined;
  return raw?.bufferedAmount ?? 0;
}

function send(ws: WSContext, msg: BrowserServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
