import { z } from "zod";
import { Id } from "./common";
import {
  BrowserCommandResults,
  BrowserDialog,
  BrowserDialogClosed,
  BrowserEngine,
  BrowserFrameMetadata,
  BrowserInput,
  BrowserTab,
  BrowserTabId,
  MAX_DIALOG_TEXT,
} from "./runner/browser";

/**
 * Browser panel HTTP and WebSocket shapes (§12.2). Routes live under
 * `/api/sessions/:id/browser`; the live view is the `/ws/browser` channel. Every call acts on
 * the session's own browser context in the runner.
 */

/**
 * `POST /api/sessions/:id/browser/open`: open (or reuse) the context, optionally at `url`.
 * `native`: the desktop app's window asks; a session with no browser yet opens on native views
 * when the desktop app offers them (§17), else on the runner's Chromium.
 */
export const BrowserOpenRequest = z.object({
  url: z.string().min(1).max(8_000).optional(),
  native: z.boolean().optional(),
});
export type BrowserOpenRequest = z.infer<typeof BrowserOpenRequest>;

export const BrowserOpenResponse = z.object({
  /** CDP endpoint on 127.0.0.1 (for diagnostics; the panel never connects to it). */
  cdpUrl: z.string().nullable(),
  tabs: z.array(BrowserTab),
  /** What backs the browser; absent from older servers (`runner`). */
  engine: BrowserEngine.optional(),
});
export type BrowserOpenResponse = z.infer<typeof BrowserOpenResponse>;

/** `GET /api/sessions/:id/browser/tabs`. `open` is false when the session has no browser. */
export const BrowserTabsResponse = z.object({
  open: z.boolean(),
  tabs: z.array(BrowserTab),
  /** What backs the browser while it is open. */
  engine: BrowserEngine.optional(),
  /** Page dialogs waiting for an answer (absent when there are none). */
  dialogs: z.array(BrowserDialog).optional(),
});
export type BrowserTabsResponse = z.infer<typeof BrowserTabsResponse>;

/** `POST /api/sessions/:id/browser/tabs`: open a new tab. Response: `{ tab }`. */
export const BrowserNewTabRequest = z.object({ url: z.string().min(1).max(8_000).optional() });
export type BrowserNewTabRequest = z.infer<typeof BrowserNewTabRequest>;

export const BrowserTabResponse = z.object({ tab: BrowserTab });
export type BrowserTabResponse = z.infer<typeof BrowserTabResponse>;

/** `POST /api/sessions/:id/browser/navigate`. Bare `host:port` gets `http://`. */
export const BrowserNavigateRequest = z.object({
  url: z.string().min(1).max(8_000),
  tabId: BrowserTabId.optional(),
});
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequest>;

export const BrowserNavigateResponse = BrowserCommandResults["browser.navigate"];
export type BrowserNavigateResponse = z.infer<typeof BrowserNavigateResponse>;

/** `POST /api/sessions/:id/browser/history`. Response: `{ url }`. */
export const BrowserHistoryRequest = z.object({
  action: z.enum(["back", "forward", "reload"]),
  tabId: BrowserTabId.optional(),
});
export type BrowserHistoryRequest = z.infer<typeof BrowserHistoryRequest>;

/**
 * `POST /api/sessions/:id/browser/viewport` (CSS pixels, every tab of the session). The
 * panel sizes the viewport over `/ws/browser` instead; a later panel resize replaces this.
 */
export const BrowserViewportRequest = z.object({
  width: z.int().min(200).max(7680),
  height: z.int().min(200).max(4320),
  deviceScaleFactor: z.number().min(0.25).max(8).optional(),
});
export type BrowserViewportRequest = z.infer<typeof BrowserViewportRequest>;

/** `POST /api/sessions/:id/browser/dev-server`: open `http://localhost:<port><path>` in a new tab. */
export const BrowserDevServerRequest = z.object({
  port: z.int().min(1).max(65535),
  path: z.string().startsWith("/").max(2_000).optional(),
});
export type BrowserDevServerRequest = z.infer<typeof BrowserDevServerRequest>;

/** A local dev server the runner found listening (its own descendants or probed ports). */
export const DevServer = z.object({
  port: z.int().min(1).max(65535),
  pid: z.int().nullable(),
  url: z.string(),
});
export type DevServer = z.infer<typeof DevServer>;

/** `GET /api/browser/dev-servers?probe=3000,5173`. */
export const DevServersResponse = z.object({ servers: z.array(DevServer) });
export type DevServersResponse = z.infer<typeof DevServersResponse>;

// ------------------------------------------------------------------ /ws/browser channel

/**
 * Query of `/ws/browser`. One socket is one viewer of one session's browser. With
 * `open=1` the server opens the session's browser when it is not open yet; otherwise the
 * viewer waits and starts watching as soon as the agent (or another viewer) opens it.
 *
 * `native=1` comes from the desktop app's window, which can show native views itself (§17):
 * opens prefer native views, and the viewer starts without frames. It still gets state, tabs
 * and agent activity, and sends `watch` (and viewport reports) when the session's browser is on
 * the runner's Chromium instead.
 */
export const BrowserWsQuery = z.object({
  sessionId: Id,
  open: z.enum(["0", "1"]).optional(),
  native: z.enum(["0", "1"]).optional(),
  quality: z.coerce.number().int().min(10).max(100).optional(),
  maxWidth: z.coerce.number().int().min(100).max(7680).optional(),
  maxHeight: z.coerce.number().int().min(100).max(4320).optional(),
  maxFps: z.coerce.number().int().min(1).max(60).optional(),
});
export type BrowserWsQuery = z.infer<typeof BrowserWsQuery>;

/** Screencast settings a viewer may change with `watch`. */
export const BrowserScreencastSettings = z.object({
  quality: z.int().min(10).max(100).optional(),
  maxWidth: z.int().min(100).max(7680).optional(),
  maxHeight: z.int().min(100).max(4320).optional(),
  maxFps: z.int().min(1).max(60).optional(),
});
export type BrowserScreencastSettings = z.infer<typeof BrowserScreencastSettings>;

/**
 * A viewer's panel size: its content box in CSS pixels and its `devicePixelRatio`. Raw
 * measurements; the runner clamps them when it applies the viewport.
 */
export const BrowserViewportSize = z.object({
  width: z.int().min(1).max(16_384),
  height: z.int().min(1).max(16_384),
  deviceScaleFactor: z.number().min(0.25).max(8),
});
export type BrowserViewportSize = z.infer<typeof BrowserViewportSize>;

/** Client -> server messages on `/ws/browser` (JSON text frames). */
export const BrowserClientMessage = z.discriminatedUnion("type", [
  /** Human input for the active tab (mouse coordinates in displayed-frame space). */
  z.object({ type: z.literal("input"), input: BrowserInput }),
  /** Start (or re-tune) the screencast for this viewer. */
  z.object({ type: z.literal("watch"), settings: BrowserScreencastSettings.optional() }),
  /** Stop receiving frames (tab updates still arrive); the screencast pauses with no viewers. */
  z.object({ type: z.literal("unwatch") }),
  /** Open the session's browser now (same as `open=1`). */
  z.object({ type: z.literal("open"), url: z.string().min(1).max(8_000).optional() }),
  /**
   * The size this viewer wants the page at: its panel's content box in CSS pixels and its
   * `devicePixelRatio`. One viewer owns the session's viewport at a time: the first to report
   * a size, until another viewer sends `claim: true` (it was focused or used). The page follows
   * the owner's reports; when the owner leaves, the most recent claimant still connected takes
   * over. The runner clamps the size (see `browser.viewport`).
   */
  BrowserViewportSize.extend({ type: z.literal("viewport"), claim: z.boolean().optional() }),
  /**
   * Answer the page dialog open on `tabId` (see `dialogs`): `accept` is OK (Leave), otherwise
   * Cancel; `promptText` is what a prompt returns.
   */
  z.object({
    type: z.literal("dialog"),
    tabId: BrowserTabId,
    accept: z.boolean(),
    promptText: z.string().max(MAX_DIALOG_TEXT).optional(),
  }),
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessage>;

/** Server -> client messages on `/ws/browser` (JSON text frames). */
export const BrowserServerMessage = z.discriminatedUnion("type", [
  /** Sent once after connecting, and again when the browser opens or closes. */
  z.object({
    type: z.literal("state"),
    viewerId: z.string(),
    open: z.boolean(),
    watching: z.boolean(),
    tabs: z.array(BrowserTab),
    /** What backs the browser while it is open (absent from older servers: `runner`). */
    engine: BrowserEngine.optional(),
  }),
  /** A screencast frame of the active tab. */
  z.object({
    type: z.literal("frame"),
    mediaType: z.enum(["image/jpeg", "image/png"]),
    /** Base64 image data. */
    data: z.string(),
    width: z.int().positive(),
    height: z.int().positive(),
    tabId: BrowserTabId.optional(),
    metadata: BrowserFrameMetadata.optional(),
  }),
  /** The session's tabs changed (opened, closed, activated, navigated, retitled). */
  z.object({
    type: z.literal("tabs"),
    tabs: z.array(BrowserTab),
    engine: BrowserEngine.optional(),
  }),
  /**
   * The viewport the runner applied (CSS pixels and device scale factor). `mine` is true when
   * it follows this viewer's panel, so the panel can fill edge to edge; other viewers fit the
   * frame inside their panel instead.
   */
  z.object({
    type: z.literal("viewport"),
    width: z.int().positive(),
    height: z.int().positive(),
    deviceScaleFactor: z.number().positive(),
    mine: z.boolean(),
  }),
  /**
   * Whether an agent is driving the browser: true while an agent `browser_*` tool runs and for
   * a short while after the last one. Human input is never blocked either way.
   */
  z.object({ type: z.literal("agent"), acting: z.boolean() }),
  /**
   * The page dialogs waiting for an answer (an `alert`, `confirm`, `prompt` or "Leave site?"),
   * at most one per tab; sent on connect when there are any, and whenever one opens or closes.
   * The page is paused until a viewer or an agent answers, or `DIALOG_TIMEOUT_MS` passes.
   * `closed`: the dialog that just closed, and who closed it.
   */
  z.object({
    type: z.literal("dialogs"),
    dialogs: z.array(BrowserDialog),
    closed: BrowserDialogClosed.optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessage>;
