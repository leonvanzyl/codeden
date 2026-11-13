import type { BrowserRelayEndpoint } from "@codeden/contracts";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserCommandHandlers,
  BrowserManager,
  createBrowserCommandHandlers,
  findInstalledChannels,
  type LaunchedBrowser,
  launchChromium,
} from "../src/browser";
import { toPlaywrightCookies } from "../src/browser/relay";
import { isAlive, killTree } from "../src/process/tree";
import { StreamRecorder, TestSite } from "./browser-helpers";

const hasBrowser = findInstalledChannels().length > 0;

/** Wait for a teardown step, but never longer than `ms`; failures are ignored. */
const within = (step: Promise<unknown> | undefined, ms = 10_000) =>
  Promise.race([
    (step ?? Promise.resolve()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);

const relay: BrowserRelayEndpoint = {
  url: "ws://127.0.0.1:1/cdp/s1",
  secret: "x".repeat(64),
};

/**
 * The native engine (§17 Phase 2) against a stand-in for the desktop app: a second Chromium
 * whose CDP endpoint plays the relay (the relay itself is tested in the desktop app). The
 * runner must drive those tabs without emulating a viewport, take them over in its own
 * Chromium on hand-off with their URLs and cookies, and reopen them when the app vanishes.
 */
describe.skipIf(!hasBrowser)("native engine (installed Edge/Chrome)", { timeout: 60_000 }, () => {
  let site: TestSite;
  let app: LaunchedBrowser;
  let recorder: StreamRecorder;
  let manager: BrowserManager;
  let handlers: BrowserCommandHandlers;
  const clients: Browser[] = [];

  /** What the app's relay hands the runner: a connection that sees one context. */
  const connect = async () => {
    const browser = await chromium.connectOverCDP(app.cdpUrl);
    clients.push(browser);
    const context = browser.contexts()[0];
    if (!context) throw new Error("no context");
    return { browser, context };
  };

  beforeAll(async () => {
    site = await TestSite.start();
    app = await launchChromium();
    recorder = new StreamRecorder();
    manager = new BrowserManager({ stream: recorder.push, connect });
    handlers = createBrowserCommandHandlers({ manager });
  }, 60_000);
  afterAll(async () => {
    // Every step is bounded: a browser that never finishes closing must not hold the worker.
    await within(manager?.shutdown());
    for (const c of clients) await within(c.close());
    await within(app?.browser.close());
    if (app?.pid && isAlive(app.pid)) await killTree(app.pid);
    await within(site?.close());
  }, 60_000);

  it("opens on the app's views, never emulates their size, and drives them", async () => {
    const opened = await handlers.execute({
      name: "browser.open",
      sessionId: "s1",
      url: site.url,
      relay,
    });
    expect(opened).toMatchObject({ engine: "native", cdpUrl: null });
    // The runner launched no Chromium of its own.
    expect(manager.cdpUrl).toBeNull();
    const tabs = recorder.items.filter((i) => i.kind === "browser.tabs" && i.sessionId === "s1");
    expect(tabs.at(-1)).toMatchObject({ engine: "native" });

    const page = manager.get("s1").page();
    const before = await page.evaluate("[innerWidth, innerHeight]");
    const viewport = await handlers.handlers["browser.viewport"]({
      name: "browser.viewport",
      sessionId: "s1",
      width: 400,
      height: 300,
      deviceScaleFactor: 2,
    });
    expect(viewport.fixed).toBe(true);
    expect([viewport.width, viewport.height]).toEqual(before);
    expect(await page.evaluate("[innerWidth, innerHeight]")).toEqual(before);

    const snap = await handlers.handlers["browser.snapshot"]({
      name: "browser.snapshot",
      sessionId: "s1",
    });
    const ref = /button "Press me" \[ref=(\w+)\]/.exec(snap.snapshot)?.[1] ?? "";
    await handlers.execute({ name: "browser.click", sessionId: "s1", ref });
    expect(await page.textContent("#big")).toBe("clicked by human");
    const list = await handlers.handlers["browser.tabs.list"]({
      name: "browser.tabs.list",
      sessionId: "s1",
    });
    expect(list.engine).toBe("native");
  });

  it("maps a viewer's clicks on the view's own size, not the frame metadata's", async () => {
    const page = manager.get("s1").page();
    await page.goto(site.url);
    const [width, height] = (await page.evaluate("[innerWidth, innerHeight]")) as number[];
    // A phone draws a 400x300 frame of the whole view; the metadata claims half the size (as
    // HiDPI macOS can report DIPs). The click aims at the big button's centre (200, 150 CSS).
    const at = { x: (200 / (width ?? 1)) * 400, y: (150 / (height ?? 1)) * 300 };
    const pointer = {
      ...at,
      frameWidth: 400,
      frameHeight: 300,
      viewportWidth: (width ?? 2) / 2,
      viewportHeight: (height ?? 2) / 2,
      button: "left" as const,
      clickCount: 1,
    };
    for (const type of ["mouse.down", "mouse.up"] as const) {
      await handlers.execute({
        name: "browser.input",
        sessionId: "s1",
        input: { type, ...pointer },
      });
    }
    expect(await page.textContent("#big")).toBe("clicked by human");
  });

  it("a viewer's screencast follows the view's real size, without emulating it", async () => {
    const session = manager.get("s1");
    const before = await session.page().evaluate("[innerWidth, innerHeight]");
    await handlers.execute({
      name: "browser.screencast",
      sessionId: "s1",
      viewerId: "phone",
      watching: true,
      maxWidth: 400,
      maxHeight: 400,
    });
    await session.page().evaluate("document.body.style.background = '#eef'");
    await expect.poll(() => recorder.frames("s1").length, { timeout: 10_000 }).toBeGreaterThan(0);
    const { width, height } = session.viewportSize;
    expect([width, height]).toEqual(before);
    expect(await session.page().evaluate("[innerWidth, innerHeight]")).toEqual(before);
    await handlers.execute({
      name: "browser.screencast",
      sessionId: "s1",
      viewerId: "phone",
      watching: false,
    });
  });

  it("adopts the tabs the app already has when it connects again", async () => {
    const other = new BrowserManager({ stream: () => {}, connect });
    try {
      const session = await other.open("s1", undefined, relay);
      expect(session.listTabs().map((t) => t.url)).toContain(`${site.url}/`);
    } finally {
      await other.shutdown();
    }
    // Disconnecting the other runner left the views alone.
    expect(manager.get("s1").listTabs()).toHaveLength(1);
  });

  it("moves to the runner's Chromium on hand-off, with the tabs' URLs and cookies", async () => {
    const page = manager.get("s1").page();
    await page.goto(`${site.url}/set?v=native`);
    const cookies = (await page.context().cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    const result = await handlers.execute({
      name: "browser.handoff",
      sessionId: "s1",
      tabs: [
        { url: `${site.url}/whoami`, active: true },
        { url: `${site.url}/page2`, active: false },
      ],
      cookies,
    });
    expect(result).toMatchObject({
      tabs: [
        { url: `${site.url}/whoami`, active: true },
        { url: `${site.url}/page2`, active: false },
      ],
    });
    const session = manager.get("s1");
    expect(session.engine).toBe("runner");
    expect(manager.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1/);
    expect(await session.page().textContent("#c")).toBe("who=native");
    expect(recorder.items.filter((i) => i.kind === "browser.tabs").at(-1)).toMatchObject({
      engine: "runner",
    });
  });

  it("reopens the tabs in its own Chromium when the app vanishes without a hand-off", async () => {
    await manager.open("s2", `${site.url}/page2`, relay);
    expect(manager.get("s2").engine).toBe("native");
    // The app dies: every relay connection drops at once.
    for (const c of clients) await c.close();
    const reopened = () => {
      if (!manager.has("s2")) return null;
      const s = manager.get("s2");
      return { engine: s.engine, urls: s.listTabs().map((t) => t.url) };
    };
    await expect
      .poll(reopened, { timeout: 15_000 })
      .toEqual({ engine: "runner", urls: [`${site.url}/page2`] });
  });

  it("checks an agent's coordinates against the target view's own size", async () => {
    // The shown view is 800x600; a view in the background kept 400x300 (as the app's views can).
    const session = await manager.open("s5", site.url, relay);
    const shown = session.listTabs()[0]?.tabId ?? "";
    const back = await session.openTab(site.url);
    await session.activate(shown);
    await session.page(shown).setViewportSize({ width: 800, height: 600 });
    await session.page(back.tabId).setViewportSize({ width: 400, height: 300 });
    const click = (x: number, y: number, tabId?: string) =>
      handlers.execute({ name: "browser.mouse", sessionId: "s5", tabId, action: "click", x, y });

    // Inside the shown view, outside the background one: refused with the target's size.
    await expect(click(700, 500, back.tabId)).rejects.toMatchObject({
      code: "out_of_bounds",
      message: expect.stringContaining("(400x300 CSS pixels)"),
    });
    // Inside the background view: accepted there, on that tab (its big button is at 100-300).
    await click(200, 150, back.tabId);
    expect(await session.page(back.tabId).textContent("#big")).toBe("clicked by human");
    // The shown view is still measured as itself.
    await click(700, 500);
    await expect(click(850, 10)).rejects.toMatchObject({
      message: expect.stringContaining("(800x600 CSS pixels)"),
    });
    expect([session.viewportSize.width, session.viewportSize.height]).toEqual([800, 600]);
    await handlers.execute({ name: "browser.close", sessionId: "s5" });
  });

  it("a page stuck in a long script can't stall a native viewport answer", async () => {
    await manager.open("s4", site.url, relay);
    const page = manager.get("s4").page();
    // Busy for 4 s: an unbounded measurement would wait it out.
    await page.evaluate(
      "setTimeout(() => { const end = Date.now() + 4000; while (Date.now() < end); }, 0)",
    );
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const viewport = await handlers.handlers["browser.viewport"]({
      name: "browser.viewport",
      sessionId: "s4",
      width: 800,
      height: 600,
    });
    expect(viewport.fixed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_500);
    await handlers.execute({ name: "browser.close", sessionId: "s4" });
  });

  it("closing a native browser closes its views", async () => {
    await manager.open("s3", site.url, relay);
    const appContext = clients.at(-1)?.contexts()[0];
    const count = () => appContext?.pages().length ?? 0;
    const before = count();
    await handlers.execute({ name: "browser.close", sessionId: "s3" });
    expect(manager.has("s3")).toBe(false);
    await expect.poll(count).toBe(before - 1);
  });
});

describe("hand-off cookies", () => {
  it("keeps session cookies and drops SameSite=None without Secure", () => {
    expect(
      toPlaywrightCookies([
        {
          name: "a",
          value: "1",
          domain: "localhost",
          path: "",
          httpOnly: true,
          secure: false,
          sameSite: "None",
        },
        {
          name: "b",
          value: "2",
          domain: ".example.com",
          path: "/x",
          expires: 1_900_000_000,
          httpOnly: false,
          secure: true,
          sameSite: "None",
        },
      ]),
    ).toEqual([
      {
        name: "a",
        value: "1",
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
      },
      {
        name: "b",
        value: "2",
        domain: ".example.com",
        path: "/x",
        expires: 1_900_000_000,
        httpOnly: false,
        secure: true,
        sameSite: "None",
      },
    ]);
  });
});
