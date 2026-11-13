import type {
  BrowserEngine,
  BrowserHandoffTab,
  BrowserInput,
  BrowserTab,
  RunnerStream,
} from "@codeden/contracts";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { CommandError } from "../errors";
import { InputForwarder } from "./input";
import { BrowserLogs } from "./logs";
import { type FrameStream, Screencast } from "./screencast";
import { normalizeUrl } from "./urls";
import {
  deviceMetricsParams,
  fitViewport,
  framePixels,
  sameViewport,
  type ViewportMetrics,
} from "./viewport";

export interface BrowserSessionOptions {
  sessionId: string;
  /** Created with `viewport: null`: the session emulates the viewport itself over CDP. */
  context: BrowserContext;
  viewport: ViewportMetrics;
  stream: (data: RunnerStream) => void;
  /** Default timeout for navigation and agent actions. */
  timeoutMs: number;
  /**
   * `native`: the tabs are the desktop app's views behind its CDP relay (§17 Phase 2). Their
   * size follows the desktop panel, so the session never emulates a viewport. Default `runner`.
   */
  engine?: BrowserEngine;
  /** Native only: drop the relay connection (the views stay in the app). */
  disconnect?: () => Promise<void>;
}

/** Native tabs that close within this long of each other count as one disconnect. */
const NATIVE_CLOSE_SETTLE_MS = 100;
/** How long a measured native view size is trusted for mapping a viewer's pointer input. */
const NATIVE_MEASURE_MS = 1_000;
/** Screencast frame cap for native views: their size is the desktop panel's, up to 4K-class. */
const nativeFrame = () => framePixels(fitViewport({ width: 3840, height: 2400 }));

/** Measuring a native view gives up after this long (the page may be stuck in a script). */
const NATIVE_MEASURE_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface TabState {
  tabId: string;
  page: Page;
  cdp?: Promise<CDPSession>;
  /** Settles once the session's viewport is emulated on the tab. */
  sized: Promise<void>;
}

/**
 * One CodeDen session's isolated browser context (§12.2): its tabs, the active tab the
 * panel shows, the screencast, input forwarding and bounded console/network logs.
 */
export class BrowserSession {
  readonly sessionId: string;
  readonly context: BrowserContext;
  readonly engine: BrowserEngine;
  readonly logs = new BrowserLogs();
  readonly screencast: Screencast;
  private readonly tabs = new Map<string, TabState>();
  private readonly titles = new Map<string, string>();
  private readonly byPage = new WeakMap<Page, TabState>();
  private readonly input = new InputForwarder();
  private readonly stream: (data: RunnerStream) => void;
  private activeTabId: string | undefined;
  private nextTab = 1;
  private viewport: ViewportMetrics;
  private closed = false;
  /** Native: the relay connection dropped; tabs closing now are not really closing. */
  private disconnected = false;
  /** Native: when the view's size was last measured (it follows the desktop panel). */
  private measuredAt = 0;
  private lastPublished = "";
  readonly timeoutMs: number;
  private readonly disconnect: (() => Promise<void>) | undefined;

  constructor(opts: BrowserSessionOptions) {
    this.sessionId = opts.sessionId;
    this.context = opts.context;
    this.viewport = opts.viewport;
    this.stream = opts.stream;
    this.timeoutMs = opts.timeoutMs;
    this.engine = opts.engine ?? "runner";
    this.disconnect = opts.disconnect;
    this.context.setDefaultTimeout(opts.timeoutMs);
    this.context.setDefaultNavigationTimeout(opts.timeoutMs);
    this.screencast = new Screencast(opts.sessionId, (frame: FrameStream) => this.stream(frame));
    // Native views have whatever size the desktop panel gives them: frames are only capped.
    const frame = this.native ? nativeFrame() : framePixels(this.viewport);
    void this.screencast.setFrameSize(frame, this.viewport);
    // Pages opened by the page itself (popups, target=_blank) become tabs too.
    this.context.on("page", (page) => {
      if (!this.byPage.has(page)) this.register(page, false);
    });
    // A relay announces the views the app already has (the runner reconnected).
    for (const page of this.context.pages()) if (!this.byPage.has(page)) this.register(page, true);
  }

  private get native(): boolean {
    return this.engine === "native";
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The viewport every tab is emulated at (CSS pixels and device scale factor). */
  get viewportSize(): ViewportMetrics {
    return { ...this.viewport };
  }

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map(({ tabId, page }) => ({
      tabId,
      url: page.url(),
      title: this.titles.get(tabId) ?? "",
      active: tabId === this.activeTabId,
    }));
  }

  /** Open a new tab (optionally at `url`) and make it active. */
  async openTab(url?: string): Promise<BrowserTab> {
    this.assertOpen();
    const page = await this.context.newPage();
    const state = this.byPage.get(page) ?? this.register(page, true);
    await this.activate(state.tabId);
    if (url) await this.navigate(url, state.tabId);
    return this.tabInfo(state.tabId);
  }

  async closeTab(tabId: string): Promise<void> {
    const state = this.tabState(tabId);
    await state.page.close();
  }

  /** Make a tab the one the panel shows and commands target by default. */
  async activate(tabId: string): Promise<void> {
    const state = this.tabState(tabId);
    if (this.activeTabId !== tabId) {
      this.activeTabId = tabId;
      this.publishTabs();
    }
    await state.page.bringToFront().catch(() => undefined);
    await state.sized;
    await this.screencast.setTab({ tabId, cdp: await this.cdp(state) });
  }

  /** The page of `tabId`, or of the active tab. */
  page(tabId?: string): Page {
    return this.tabState(tabId).page;
  }

  /** Resolve a tab id (default: the active tab). */
  tabId(tabId?: string): string {
    return this.tabState(tabId).tabId;
  }

  async navigate(url: string, tabId?: string): Promise<{ url: string; status: number | null }> {
    const page = this.page(tabId);
    const response = await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded" });
    await this.refreshTitle(page);
    return { url: page.url(), status: response?.status() ?? null };
  }

  async history(action: "back" | "forward" | "reload", tabId?: string): Promise<string> {
    const page = this.page(tabId);
    const options = { waitUntil: "domcontentloaded" as const };
    if (action === "back") await page.goBack(options);
    else if (action === "forward") await page.goForward(options);
    else await page.reload(options);
    await this.refreshTitle(page);
    return page.url();
  }

  /**
   * Set the viewport of every tab, and of tabs opened later. The request is clamped
   * (`fitViewport`); the screencast follows with frames at the new device pixels.
   * Returns what was applied.
   */
  async setViewport(request: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<ViewportMetrics> {
    this.assertOpen();
    // A native view is as big as the desktop panel: report that instead of emulating.
    if (this.native) return this.measure();
    const next = fitViewport(request);
    if (sameViewport(next, this.viewport)) return { ...next };
    this.viewport = next;
    await Promise.all(
      [...this.tabs.values()].map((state) => {
        state.sized = this.emulate(state);
        return state.sized;
      }),
    );
    await this.screencast.setFrameSize(framePixels(next), next);
    return { ...next };
  }

  /** Forward panel input to the active tab. */
  async dispatchInput(input: BrowserInput): Promise<void> {
    const state = this.tabState();
    if (this.native && "frameWidth" in input) {
      // A native view's frame always shows the whole view, so map against the view's own CSS
      // size. Frame metadata isn't trusted for that: its units follow the platform's scale
      // handling (DIPs rather than CSS pixels on HiDPI macOS).
      const { viewportWidth: _w, viewportHeight: _h, ...pointer } = input;
      const viewport = await this.nativeViewport();
      return this.input.dispatch(await this.cdp(state), pointer, viewport);
    }
    await this.input.dispatch(await this.cdp(state), input, this.viewport);
  }

  /**
   * Close the session's browser. Native: with `closeTabs` (the browser was closed) the views
   * close too; without it (the runner stops, or the session moves to the runner's Chromium) only
   * the relay connection is dropped and the views stay in the app.
   */
  async close(opts: { closeTabs?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.screencast.dispose();
    if (this.native) {
      if (opts.closeTabs) {
        await Promise.all([...this.tabs.values()].map((t) => t.page.close().catch(() => {})));
      }
      await this.disconnect?.().catch(() => undefined);
    } else {
      await this.context.close().catch(() => undefined);
    }
    this.tabs.clear();
    this.activeTabId = undefined;
  }

  /**
   * Native: the relay connection dropped (the app quit or crashed). Returns the tabs as they
   * were, for reopening them in the runner's Chromium; the session is closed.
   */
  markDisconnected(): BrowserHandoffTab[] {
    const tabs = [...this.tabs.values()].map(({ tabId, page }) => ({
      url: page.url(),
      active: tabId === this.activeTabId,
    }));
    this.disconnected = true;
    this.closed = true;
    void this.screencast.dispose();
    this.tabs.clear();
    this.activeTabId = undefined;
    return tabs;
  }

  private register(page: Page, quiet: boolean): TabState {
    const tabId = `t${this.nextTab++}`;
    const state: TabState = { tabId, page, sized: Promise.resolve() };
    this.tabs.set(tabId, state);
    this.byPage.set(page, state);
    this.logs.attach(page, tabId);
    state.sized = this.emulate(state);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.refreshTitle(page);
    });
    page.on("load", () => void this.refreshTitle(page));
    page.on("close", () => {
      // A dropped relay closes every native tab at once: wait a moment to tell that apart
      // from a tab really closing, so the tabs can still be reopened elsewhere.
      if (this.native) setTimeout(() => void this.onClosed(state), NATIVE_CLOSE_SETTLE_MS);
      else void this.onClosed(state);
    });
    if (!this.activeTabId) void this.activate(tabId).catch(() => undefined);
    else if (!quiet) this.publishTabs();
    return state;
  }

  private async onClosed(state: TabState): Promise<void> {
    if (this.disconnected) return;
    this.tabs.delete(state.tabId);
    this.titles.delete(state.tabId);
    if (this.closed) return;
    if (this.activeTabId === state.tabId) {
      this.activeTabId = undefined;
      const next = [...this.tabs.keys()].at(-1);
      if (next) await this.activate(next).catch(() => undefined);
      else await this.screencast.setTab(undefined);
    }
    this.publishTabs();
  }

  private async refreshTitle(page: Page): Promise<void> {
    const state = this.byPage.get(page);
    if (!state || page.isClosed()) return;
    this.titles.set(state.tabId, await page.title().catch(() => ""));
    this.publishTabs();
  }

  /** Emulate the session viewport on a tab (never throws: a closing tab just stays as is). */
  private async emulate(state: TabState): Promise<void> {
    if (this.native) return;
    try {
      const cdp = await this.cdp(state);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        deviceMetricsParams(this.viewport) as never,
      );
    } catch {
      // The tab closed under us.
    }
  }

  /**
   * A view's own size (CSS pixels and scale); undefined while it has none. Throws when the page
   * doesn't answer in time.
   */
  private async viewSize(page: Page): Promise<ViewportMetrics | undefined> {
    // A string: the runner has no DOM types, and the page computes it in its own realm. A page
    // busy in a long script must not stall input or a viewport answer.
    const metrics = (await withTimeout(
      page.evaluate("[window.innerWidth, window.innerHeight, window.devicePixelRatio]"),
      NATIVE_MEASURE_TIMEOUT_MS,
    )) as number[];
    const [width, height, scale] = metrics;
    return width && height ? { width, height, deviceScaleFactor: scale || 1 } : undefined;
  }

  /** The shown native view's actual size, as the desktop panel laid it out (kept on failure). */
  private async measure(): Promise<ViewportMetrics> {
    try {
      const next = await this.viewSize(this.page());
      if (next) {
        const changed = !sameViewport(next, this.viewport);
        this.viewport = next;
        // The screencast's metadata for stills, and its frame size floor, follow the real view.
        if (changed) void this.screencast.setFrameSize(nativeFrame(), next);
      }
      this.measuredAt = Date.now();
    } catch {
      // No tab yet, or it is navigating: keep the last size.
    }
    return { ...this.viewport };
  }

  /**
   * Native: measure the view now (a viewer starts watching), so the screencast knows its real
   * size. The runner engine owns its size already.
   */
  async syncViewport(): Promise<void> {
    if (this.native) await this.measure();
  }

  /**
   * The viewport of `tabId` (default: the active tab) that an agent's coordinates refer to, now:
   * the emulated size every tab shares, or a native view's own size measured fresh (agent actions
   * are few, and the panel may have just resized). A native view in the background can differ
   * from the shown one; measuring it leaves the session's viewport, which follows the shown
   * view, alone. A view that doesn't answer in time gets the last known size, as for input.
   */
  async currentViewport(tabId?: string): Promise<ViewportMetrics> {
    const state = this.tabState(tabId);
    if (!this.native) return { ...this.viewport };
    if (state.tabId === this.activeTabId) return this.measure();
    const size = await this.viewSize(state.page).catch(() => undefined);
    return size ?? { ...this.viewport };
  }

  /** The native view's size for input, measured at most once a second (pointer moves are many). */
  private async nativeViewport(): Promise<ViewportMetrics> {
    if (Date.now() - this.measuredAt > NATIVE_MEASURE_MS) return this.measure();
    return { ...this.viewport };
  }

  private cdp(state: TabState): Promise<CDPSession> {
    state.cdp ??= this.context.newCDPSession(state.page);
    return state.cdp;
  }

  private tabInfo(tabId: string): BrowserTab {
    const tab = this.listTabs().find((t) => t.tabId === tabId);
    if (!tab) throw new CommandError("not_found", `No tab ${tabId}`);
    return tab;
  }

  private tabState(tabId?: string): TabState {
    this.assertOpen();
    const id = tabId ?? this.activeTabId;
    const state = id ? this.tabs.get(id) : undefined;
    if (!state) {
      throw new CommandError(
        "not_found",
        tabId ? `No tab ${tabId}` : "The session has no open tab",
      );
    }
    return state;
  }

  private assertOpen(): void {
    if (this.closed) throw new CommandError("not_found", "The browser session is closed");
  }

  private publishTabs(): void {
    if (this.closed) return;
    const tabs = this.listTabs();
    const key = JSON.stringify(tabs);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.stream({ kind: "browser.tabs", sessionId: this.sessionId, tabs, engine: this.engine });
  }
}
