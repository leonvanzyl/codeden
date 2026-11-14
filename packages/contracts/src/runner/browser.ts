import { z } from "zod";
import { Id } from "../common";

/** Most bytes of a PNG `browser.screenshot` returns inline (12 MiB), to fit one link frame. */
export const SCREENSHOT_INLINE_MAX_BYTES = 12 * 1024 * 1024;

/** Runner-assigned tab id, unique within a session's browser context (`t1`, `t2`, ...). */
export const BrowserTabId = z.string().min(1).max(100);
export type BrowserTabId = z.infer<typeof BrowserTabId>;

/** One tab of a session's browser context. */
export const BrowserTab = z.object({
  tabId: BrowserTabId,
  url: z.string(),
  title: z.string(),
  /** The tab shown in the panel and targeted when a command omits `tabId`. */
  active: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

/** CDP modifier bitmask: Alt = 1, Ctrl = 2, Meta = 4, Shift = 8. */
export const BrowserModifiers = z.int().min(0).max(15);

/**
 * Aria ref from a `browser.snapshot` (`e2`, or `f1e3` inside an iframe). Refs resolve
 * against the latest snapshot of the tab.
 */
export const BrowserElementRef = z.string().regex(/^(f\d+)?e\d+$/);

/**
 * Pointer input from the panel. `x`/`y` are in the coordinate space of the frame as it
 * is displayed (`frameWidth` x `frameHeight`); the runner maps them onto the page viewport.
 */
export const BrowserMouseInput = z.object({
  type: z.enum(["mouse.move", "mouse.down", "mouse.up", "mouse.wheel"]),
  x: z.number(),
  y: z.number(),
  frameWidth: z.number().positive(),
  frameHeight: z.number().positive(),
  /**
   * Page viewport (CSS pixels) of the frame the user pointed at, from its metadata. The
   * runner maps against it, so input stays exact while a resize is in flight.
   */
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
  button: z.enum(["none", "left", "middle", "right"]).optional(),
  clickCount: z.int().min(0).max(3).optional(),
  /** Wheel deltas in page CSS pixels (`mouse.wheel`). */
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  modifiers: BrowserModifiers.optional(),
});
export type BrowserMouseInput = z.infer<typeof BrowserMouseInput>;

/** Keyboard input from the panel, mirroring DOM `KeyboardEvent` fields. */
export const BrowserKeyInput = z.object({
  type: z.enum(["key.down", "key.up", "key.char"]),
  /** DOM `key`, e.g. `a`, `Enter`, `ArrowLeft`. */
  key: z.string().min(1).max(40),
  /** DOM `code`, e.g. `KeyA`. */
  code: z.string().max(40).optional(),
  /** Text the key produces (printable keys). */
  text: z.string().max(10).optional(),
  modifiers: BrowserModifiers.optional(),
});
export type BrowserKeyInput = z.infer<typeof BrowserKeyInput>;

/** Insert text at the focused element as if typed by an IME (paste-like). */
export const BrowserTextInput = z.object({
  type: z.literal("text.insert"),
  text: z.string().max(100_000),
});
export type BrowserTextInput = z.infer<typeof BrowserTextInput>;

/** Human input forwarded from the panel to the active tab. */
export const BrowserInput = z.union([BrowserMouseInput, BrowserKeyInput, BrowserTextInput]);
export type BrowserInput = z.infer<typeof BrowserInput>;

/** A console message (or uncaught page error) captured from a tab. Bounded per session. */
export const BrowserConsoleEntry = z.object({
  /** Monotonic per session; pass as `since` to page through new entries. */
  id: z.int().nonnegative(),
  tabId: BrowserTabId,
  /** `log`, `info`, `warning`, `error`, `debug`, ..., or `pageerror`. */
  level: z.string(),
  text: z.string(),
  url: z.string().optional(),
  line: z.int().optional(),
  ts: z.string(),
});
export type BrowserConsoleEntry = z.infer<typeof BrowserConsoleEntry>;

/** A network request made by a tab. Bounded per session. */
export const BrowserNetworkEntry = z.object({
  id: z.int().nonnegative(),
  tabId: BrowserTabId,
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  /** HTTP status; null while pending or when the request failed. */
  status: z.int().nullable(),
  /** Failure text (`net::ERR_...`) when the request failed. */
  failure: z.string().nullable(),
  ts: z.string(),
  durationMs: z.number().nullable(),
});
export type BrowserNetworkEntry = z.infer<typeof BrowserNetworkEntry>;

/** Screencast frame metadata from CDP `Page.screencastFrame` (CSS pixels). */
export const BrowserFrameMetadata = z.object({
  /** Seconds since epoch when the frame was produced. */
  timestamp: z.number().optional(),
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  pageScaleFactor: z.number(),
  offsetTop: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
});
export type BrowserFrameMetadata = z.infer<typeof BrowserFrameMetadata>;

/**
 * What backs a session's browser (§12.2): the runner's own Chromium (`runner`, shown as a
 * screencast), or native views in the desktop app (`native`, §17 Phase 2), which the runner
 * drives through the app's per-session CDP relay. Agents use the same primitives on both.
 */
export const BrowserEngine = z.enum(["runner", "native"]);
export type BrowserEngine = z.infer<typeof BrowserEngine>;

/** The header that carries a relay secret (never part of the URL, so it is never logged). */
export const BROWSER_RELAY_SECRET_HEADER = "x-codeden-relay-secret";

/**
 * The desktop app's CDP relay for one session's native views (§17): a loopback WebSocket that
 * sees only that session's views, never the CodeDen window. The runner connects with the
 * secret in `BROWSER_RELAY_SECRET_HEADER`.
 */
export const BrowserRelayEndpoint = z.object({
  /** `ws://127.0.0.1:<port>/cdp/<sessionId>`. */
  url: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d{1,5}\/cdp\/[A-Za-z0-9_-]{1,200}$/),
  /** Random per-session secret. */
  secret: z.string().min(32).max(200),
});
export type BrowserRelayEndpoint = z.infer<typeof BrowserRelayEndpoint>;

/**
 * A cookie carried from native views to the runner's Chromium when the desktop app quits
 * (the subset of CDP `Network.CookieParam` both sides understand). `expires` is seconds since
 * the epoch; absent for session cookies.
 */
export const BrowserCookie = z.object({
  name: z.string().max(4_096),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(1_000),
  path: z.string().max(4_096),
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});
export type BrowserCookie = z.infer<typeof BrowserCookie>;

/** A tab moved to the runner's Chromium on hand-off: reopened at its URL. */
export const BrowserHandoffTab = z.object({
  url: z.string().max(8_000),
  /** The tab the panel showed. */
  active: z.boolean(),
});
export type BrowserHandoffTab = z.infer<typeof BrowserHandoffTab>;

/** Longest dialog text (message or default prompt text) passed on; the runner cuts the rest. */
export const MAX_DIALOG_TEXT = 10_000;

/** A page dialog nobody answers is dismissed after this long, so a page never waits forever. */
export const DIALOG_TIMEOUT_MS = 120_000;

/**
 * A page's JavaScript dialog: `alert()`, `confirm()`, `prompt()`, or the "Leave site?" of a
 * `beforeunload` handler.
 */
export const BrowserDialogType = z.enum(["alert", "confirm", "prompt", "beforeunload"]);
export type BrowserDialogType = z.infer<typeof BrowserDialogType>;

/**
 * Runner-assigned id of one page dialog (`d` + random hex). An answer names it, so an answer
 * meant for a dialog that already closed can never answer the next one on the same tab.
 */
export const BrowserDialogId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type BrowserDialogId = z.infer<typeof BrowserDialogId>;

/**
 * A page dialog waiting for an answer (§12.2). The page is paused until a viewer (the panel) or
 * an agent (`browser.dialog`) answers it, or `DIALOG_TIMEOUT_MS` passes and it is dismissed. A
 * tab shows at most one at a time.
 */
export const BrowserDialog = z.object({
  dialogId: BrowserDialogId,
  tabId: BrowserTabId,
  type: BrowserDialogType,
  /** What the page says or asks (cut to `MAX_DIALOG_TEXT`). */
  message: z.string().max(MAX_DIALOG_TEXT),
  /** `prompt` only: the text its field starts with. */
  defaultValue: z.string().max(MAX_DIALOG_TEXT).optional(),
});
export type BrowserDialog = z.infer<typeof BrowserDialog>;

/**
 * Who closed a page dialog: an `agent` or a `viewer` answered it, nobody did in time
 * (`timeout`), or the `browser` closed it (the tab closed or navigated away, or the dialog was
 * answered in the desktop app's own dialog box).
 */
export const BrowserDialogCloser = z.enum(["agent", "viewer", "timeout", "browser"]);
export type BrowserDialogCloser = z.infer<typeof BrowserDialogCloser>;

/** A page dialog that just closed, and how: `accepted` is OK (Leave), otherwise Cancel. */
export const BrowserDialogClosed = BrowserDialog.extend({
  by: BrowserDialogCloser,
  accepted: z.boolean(),
});
export type BrowserDialogClosed = z.infer<typeof BrowserDialogClosed>;

/**
 * The result of an agent action (click, type, press, pointer action). `dialog`: the action opened
 * a page dialog, which now waits for an answer (`browser.dialog`); the action finishes once it is
 * answered.
 */
const ActionResult = z.object({ dialog: BrowserDialog.optional() });

/** A key held down during an agent pointer action (`browser.mouse`). */
export const BrowserModifierKey = z.enum(["Alt", "Control", "Meta", "Shift"]);
export type BrowserModifierKey = z.infer<typeof BrowserModifierKey>;

/** What an agent does at page coordinates (`browser.mouse`, §12.2 computer use, step 1). */
export const BrowserMouseAction = z.enum(["click", "hover", "drag", "scroll"]);
export type BrowserMouseAction = z.infer<typeof BrowserMouseAction>;

/** Longest text `browser.type` types as key presses at the focused element (no `ref`). */
export const MAX_FOCUS_TYPE_CHARS = 2_000;

/** Largest scroll per axis in one agent `scroll` (CSS pixels). */
export const MAX_AGENT_SCROLL = 10_000;

/** A coordinate in the page viewport's CSS pixels; the runner checks it against the viewport. */
const ViewportCoordinate = z.number().min(0).max(100_000);

/**
 * The fields of an agent pointer action. Coordinates are CSS pixels of the tab's viewport,
 * origin top-left: the pixels of a viewport `browser.screenshot`, and the units of
 * `getBoundingClientRect`. Which fields an action takes is checked by `checkBrowserMouse`.
 */
export const BrowserMouseFields = {
  action: BrowserMouseAction,
  /** The point to act at; the start point of a drag. */
  x: ViewportCoordinate,
  y: ViewportCoordinate,
  /** Where a drag ends (`drag` only, required there). */
  toX: ViewportCoordinate.optional(),
  toY: ViewportCoordinate.optional(),
  /** Scroll amount in CSS pixels (`scroll` only, at least one non-zero); positive `deltaY` scrolls down. */
  deltaX: z.number().min(-MAX_AGENT_SCROLL).max(MAX_AGENT_SCROLL).optional(),
  deltaY: z.number().min(-MAX_AGENT_SCROLL).max(MAX_AGENT_SCROLL).optional(),
  /** `click` and `drag`; default `left`. */
  button: z.enum(["left", "middle", "right"]).optional(),
  /** `click` only: 2 is a double click, 3 a triple click. Default 1. */
  clickCount: z.int().min(1).max(3).optional(),
  /** Keys held for the whole action (shift-click, ctrl-click, alt-drag). */
  modifiers: z.array(BrowserModifierKey).max(4).optional(),
};

type BrowserMouseShape = {
  action: BrowserMouseAction;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  button?: string;
  clickCount?: number;
};

/** Fields that belong to one action only. */
const ACTION_ONLY_FIELDS: Record<string, BrowserMouseAction[]> = {
  toX: ["drag"],
  toY: ["drag"],
  deltaX: ["scroll"],
  deltaY: ["scroll"],
  button: ["click", "drag"],
  clickCount: ["click"],
};

/**
 * Cross-field rules of a pointer action, for `superRefine`: a drag needs `toX` and `toY`, a
 * scroll needs a non-zero delta, and fields of other actions are refused (so a mistaken call
 * fails instead of silently doing something else).
 */
export function checkBrowserMouse(value: BrowserMouseShape, ctx: z.RefinementCtx): void {
  for (const [field, actions] of Object.entries(ACTION_ONLY_FIELDS)) {
    if (value[field as keyof BrowserMouseShape] !== undefined && !actions.includes(value.action)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is for ${actions.join(" and ")}, not ${value.action}`,
      });
    }
  }
  if (value.action === "drag") {
    for (const field of ["toX", "toY"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `A drag needs ${field}` });
      }
    }
  }
  if (value.action === "scroll" && !value.deltaX && !value.deltaY) {
    ctx.addIssue({
      code: "custom",
      path: ["deltaY"],
      message: "A scroll needs a non-zero deltaX or deltaY",
    });
  }
}

const TabTarget = { sessionId: Id, tabId: BrowserTabId.optional() };

/** `browser.*` commands (§12.2), spread into `RunnerCommand`. */
export const BrowserCommands = [
  /**
   * Open (or reuse) the session's browser context; opens a first tab (at `url`) if none. With
   * `relay`, a session that has no browser yet is backed by the desktop app's native views
   * through that relay (`native` engine); without it, by the runner's Chromium. A session that
   * is already open keeps its engine.
   */
  z.object({
    name: z.literal("browser.open"),
    sessionId: Id,
    url: z.string().optional(),
    relay: BrowserRelayEndpoint.optional(),
  }),
  /**
   * Move the session's browser to the runner's own Chromium (the desktop app is quitting): its
   * relay connection is dropped without closing the native views, `cookies` are added to a new
   * context and each tab reopens at its URL. Unsaved page state is lost. Replaces whatever the
   * session had open.
   */
  z.object({
    name: z.literal("browser.handoff"),
    sessionId: Id,
    tabs: z.array(BrowserHandoffTab).max(50),
    cookies: z.array(BrowserCookie).max(5_000),
  }),
  /** Navigate a tab (default: the active one). Bare `host:port` gets `http://`. */
  z.object({ name: z.literal("browser.navigate"), ...TabTarget, url: z.string() }),
  /** Close the session's context and all its tabs. */
  z.object({ name: z.literal("browser.close"), sessionId: Id }),
  z.object({
    name: z.literal("browser.history"),
    ...TabTarget,
    action: z.enum(["back", "forward", "reload"]),
  }),
  z.object({ name: z.literal("browser.tabs.list"), sessionId: Id }),
  z.object({ name: z.literal("browser.tabs.open"), sessionId: Id, url: z.string().optional() }),
  z.object({ name: z.literal("browser.tabs.close"), sessionId: Id, tabId: BrowserTabId }),
  z.object({ name: z.literal("browser.tabs.activate"), sessionId: Id, tabId: BrowserTabId }),
  /**
   * Set the viewport of every tab in the session, now and for tabs opened later: CSS size
   * plus device scale factor (the viewer's `devicePixelRatio`). The runner clamps both to
   * its limits and sizes the screencast to match; the result is what it applied.
   */
  z.object({
    name: z.literal("browser.viewport"),
    sessionId: Id,
    width: z.int().min(1).max(7680),
    height: z.int().min(1).max(4320),
    /** Default 1. */
    deviceScaleFactor: z.number().min(0.25).max(8).optional(),
  }),
  /**
   * Add (`watching: true`) or remove a panel viewer. Frames stream as `browser.frame` while
   * at least one viewer watches; the screencast pauses when the last one leaves.
   */
  z.object({
    name: z.literal("browser.screencast"),
    sessionId: Id,
    viewerId: z.string().min(1).max(200),
    watching: z.boolean(),
    quality: z.int().min(10).max(100).optional(),
    maxWidth: z.int().min(100).max(7680).optional(),
    maxHeight: z.int().min(100).max(4320).optional(),
    maxFps: z.int().min(1).max(60).optional(),
  }),
  /** Forward human input to the active tab. */
  z.object({ name: z.literal("browser.input"), sessionId: Id, input: BrowserInput }),
  /** Open `http://localhost:<port><path>` in a new tab of the session. */
  z.object({
    name: z.literal("browser.devServer"),
    sessionId: Id,
    port: z.int().min(1).max(65535),
    path: z.string().startsWith("/").optional(),
  }),
  /** Accessibility snapshot (YAML) with element refs for click/type. */
  z.object({ name: z.literal("browser.snapshot"), ...TabTarget }),
  z.object({
    name: z.literal("browser.click"),
    ...TabTarget,
    ref: BrowserElementRef,
    button: z.enum(["left", "middle", "right"]).optional(),
    doubleClick: z.boolean().optional(),
  }),
  /**
   * Fill an editable element by ref, replacing its value. Without `ref`, type the text as key
   * presses into whatever has focus (at most `MAX_FOCUS_TYPE_CHARS`), e.g. a canvas editor after
   * a `browser.mouse` click. `submit` presses Enter afterwards.
   */
  z
    .object({
      name: z.literal("browser.type"),
      ...TabTarget,
      ref: BrowserElementRef.optional(),
      text: z.string().max(100_000),
      submit: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.ref === undefined && v.text.length > MAX_FOCUS_TYPE_CHARS) {
        ctx.addIssue({
          code: "custom",
          path: ["text"],
          message: `Without a ref, type at most ${MAX_FOCUS_TYPE_CHARS} characters`,
        });
      }
    }),
  /** Press a key or chord on the focused element, e.g. `Enter`, `Control+A`. */
  z.object({ name: z.literal("browser.press"), ...TabTarget, key: z.string().min(1).max(60) }),
  /**
   * Act at page coordinates (§12.2 computer use, step 1): click, hover, drag or scroll at CSS
   * pixels of the tab's viewport. The runner refuses points outside the current viewport.
   */
  z
    .object({ name: z.literal("browser.mouse"), ...TabTarget, ...BrowserMouseFields })
    .superRefine(checkBrowserMouse),
  /**
   * PNG screenshot of the viewport, the full page, or one element (`ref`): written to `path`
   * (an absolute path on the runner's machine), or without `path` returned as `data`, for a
   * runner that doesn't share the server's disk (at most `SCREENSHOT_INLINE_MAX_BYTES`, else
   * `too_large`).
   */
  z.object({
    name: z.literal("browser.screenshot"),
    ...TabTarget,
    path: z.string().min(1).optional(),
    fullPage: z.boolean().optional(),
    ref: BrowserElementRef.optional(),
  }),
  /** Console messages and/or network requests captured since `since` (exclusive). */
  z.object({
    name: z.literal("browser.logs"),
    ...TabTarget,
    /** Default `all`. */
    kind: z.enum(["console", "network", "all"]).optional(),
    since: z.int().nonnegative().optional(),
    limit: z.int().min(1).max(1000).optional(),
  }),
  /** Evaluate a JS expression or function source in the tab (guarded: timeout, size cap). */
  z.object({
    name: z.literal("browser.evaluate"),
    ...TabTarget,
    expression: z.string().min(1).max(20_000),
  }),
  /** Wait for a selector, visible text, or network idle (exactly one). */
  z.object({
    name: z.literal("browser.wait"),
    ...TabTarget,
    selector: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    networkIdle: z.boolean().optional(),
    timeoutMs: z.int().min(1).max(120_000).optional(),
  }),
  /**
   * Answer the page dialog `dialogId`. `accept` is OK (Leave, for `beforeunload`), otherwise
   * Cancel; `promptText` is what a prompt returns (default: its own default text). `by` tells
   * viewers who answered (default `agent`). Fails with `no_dialog` when that dialog is no longer
   * open (somebody answered it, or it closed): a stale answer never reaches a later dialog.
   */
  z.object({
    name: z.literal("browser.dialog"),
    sessionId: Id,
    dialogId: BrowserDialogId,
    accept: z.boolean(),
    promptText: z.string().max(MAX_DIALOG_TEXT).optional(),
    by: z.enum(["agent", "viewer"]).optional(),
  }),
] as const;

const Empty = z.object({});
const TabResult = z.object({ tab: BrowserTab });

/** Result schemas for `browser.*` commands, spread into `RunnerCommandResults`. */
export const BrowserCommandResults = {
  /**
   * `cdpUrl` is the runner Chromium's CDP endpoint on 127.0.0.1 (null for native views).
   * `engine` is absent from older runners (`runner`).
   */
  "browser.open": z.object({
    cdpUrl: z.string().nullable(),
    tabs: z.array(BrowserTab).optional(),
    engine: BrowserEngine.optional(),
  }),
  "browser.handoff": z.object({ tabs: z.array(BrowserTab) }),
  "browser.navigate": z.object({
    url: z.string().optional(),
    status: z.int().nullable().optional(),
  }),
  "browser.close": Empty,
  "browser.history": z.object({ url: z.string() }),
  /** `dialogs`: page dialogs waiting for an answer (absent from older runners). */
  "browser.tabs.list": z.object({
    tabs: z.array(BrowserTab),
    engine: BrowserEngine.optional(),
    dialogs: z.array(BrowserDialog).optional(),
  }),
  "browser.tabs.open": TabResult,
  "browser.tabs.close": Empty,
  "browser.tabs.activate": Empty,
  /**
   * The viewport the runner applied after clamping (absent from older runners). `fixed`: the
   * size is not emulated and can't follow a viewer (native views follow the desktop panel), so
   * every viewer fits the frames inside its panel.
   */
  "browser.viewport": z.object({
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    deviceScaleFactor: z.number().positive().optional(),
    fixed: z.boolean().optional(),
  }),
  "browser.screencast": z.object({ viewers: z.int().nonnegative() }),
  "browser.input": Empty,
  "browser.devServer": TabResult,
  /**
   * `dialog`: a page dialog is open on the tab. The page is paused until it is answered, so
   * `snapshot` is empty then.
   */
  "browser.snapshot": z.object({
    tabId: BrowserTabId,
    url: z.string(),
    title: z.string(),
    snapshot: z.string(),
    truncated: z.boolean(),
    dialog: BrowserDialog.optional(),
  }),
  "browser.click": ActionResult,
  "browser.type": ActionResult,
  "browser.press": ActionResult,
  "browser.mouse": ActionResult,
  "browser.screenshot": z.object({
    /** Where it was written, when the command named a path. */
    path: z.string().optional(),
    /** The PNG as base64, when the command named no path. */
    data: z
      .base64()
      .max(Math.ceil(SCREENSHOT_INLINE_MAX_BYTES / 3) * 4)
      .optional(),
    width: z.int().positive(),
    height: z.int().positive(),
    bytes: z.int().positive(),
  }),
  "browser.logs": z.object({
    console: z.array(BrowserConsoleEntry),
    network: z.array(BrowserNetworkEntry),
  }),
  /** JSON-serialized result (truncated to the size cap). */
  "browser.evaluate": z.object({ json: z.string(), truncated: z.boolean() }),
  "browser.wait": z.object({ matched: z.boolean() }),
  /** The dialog that was answered. */
  "browser.dialog": z.object({ dialog: BrowserDialog }),
};
