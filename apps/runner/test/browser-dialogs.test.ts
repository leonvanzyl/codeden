import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserCommandHandlers,
  BrowserManager,
  createBrowserCommandHandlers,
  findInstalledChannels,
  type LaunchedBrowser,
  launchChromium,
} from "../src/browser";
import { isAlive, killTree } from "../src/process/tree";
import { StreamRecorder, TestSite } from "./browser-helpers";

const hasBrowser = findInstalledChannels().length > 0;

/** Wait for a teardown step, but never longer than `ms`; failures are ignored. */
const within = (step: Promise<unknown> | undefined, ms = 10_000) =>
  Promise.race([
    (step ?? Promise.resolve()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);

function refOf(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const ref = line && /\[ref=([a-z0-9]+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`No ref for ${pattern} in:\n${snapshot}`);
  return ref;
}

/**
 * Answer the next dialog on `page` as the person at the panel (or an agent) would once it
 * shows: through a CDP session of its own. Once watching (awaited before the click), `answer`
 * settles with the dialog, whether it was still waiting for that answer, and how it had closed.
 */
async function answerNextDialog(page: Page, reply: { accept: boolean; promptText?: string }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  const closed: { result: boolean; userInput: string }[] = [];
  cdp.on("Page.javascriptDialogClosed", (event) => closed.push(event));
  const opened = new Promise<{ type: string; message: string }>((resolve) =>
    cdp.once("Page.javascriptDialogOpening", resolve),
  );
  const answer = opened.then(async ({ type, message }) => {
    let answered = true;
    let error: string | undefined;
    try {
      await cdp.send("Page.handleJavaScriptDialog", reply);
    } catch (e) {
      answered = false;
      error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
    await cdp.detach().catch(() => undefined);
    return { type, message, answered, ...(error ? { error } : {}), closedWith: closed[0] };
  });
  return { answer };
}

/**
 * Issue #183: a page's alert, confirm and prompt must wait for someone to answer them. With no
 * dialog listener anywhere, Playwright dismisses each one the moment it opens, on both engines,
 * so a "Delete this item?" confirm returns false before the user or the agent sees it.
 */
function dialogSuite(engine: "runner" | "native") {
  let site: TestSite;
  let app: LaunchedBrowser | undefined;
  let manager: BrowserManager;
  let browser: BrowserCommandHandlers;
  const recorder = new StreamRecorder();
  const clients: Browser[] = [];
  const sessionId = `dialogs-${engine}`;

  beforeAll(async () => {
    site = await TestSite.start();
    if (engine === "native") {
      // A second Chromium's CDP endpoint stands in for the desktop app's relay.
      const launched = await launchChromium();
      app = launched;
      const connect = async () => {
        const client = await chromium.connectOverCDP(launched.cdpUrl);
        clients.push(client);
        const context = client.contexts()[0];
        if (!context) throw new Error("no context");
        return { browser: client, context };
      };
      manager = new BrowserManager({ stream: recorder.push, connect });
    } else {
      manager = new BrowserManager({ stream: recorder.push });
    }
    browser = createBrowserCommandHandlers({ manager });
    await browser.execute({
      name: "browser.open",
      sessionId,
      url: `${site.url}/dialogs`,
      ...(engine === "native"
        ? { relay: { url: "ws://127.0.0.1:1/cdp/s1", secret: "x".repeat(64) } }
        : {}),
    });
  }, 60_000);
  afterAll(async () => {
    await within(manager?.shutdown());
    for (const c of clients) await within(c.close());
    await within(app?.browser.close());
    if (app?.pid && isAlive(app.pid)) await killTree(app.pid);
    await within(site?.close());
  }, 60_000);

  const page = () => manager.get(sessionId).page();
  const refFor = async (pattern: RegExp) => {
    const snap = await browser.handlers["browser.snapshot"]({
      name: "browser.snapshot",
      sessionId,
    });
    return refOf(snap.snapshot, pattern);
  };

  it("an agent's click on a confirm waits for the answer instead of getting false at once", async () => {
    await page().goto(`${site.url}/dialogs`);
    const ref = await refFor(/"Delete"/);
    const { answer } = await answerNextDialog(page(), { accept: true });
    await browser.execute({ name: "browser.click", sessionId, ref });
    expect({ dialog: await answer, out: await page().textContent("#out") }).toMatchObject({
      dialog: {
        type: "confirm",
        message: "Delete this item?",
        answered: true,
        closedWith: { result: true },
      },
      out: "deleted",
    });
  });

  it("a click from the panel on a confirm waits for the person to answer it", async () => {
    await page().goto(`${site.url}/dialogs`);
    const { width, height } = await manager.get(sessionId).currentViewport();
    // The panel draws the whole viewport 1:1; the Delete button's centre is at (200, 120).
    const pointer = { x: 200, y: 120, frameWidth: width, frameHeight: height };
    const { answer } = await answerNextDialog(page(), { accept: true });
    for (const type of ["mouse.move", "mouse.down", "mouse.up"] as const) {
      await browser.execute({
        name: "browser.input",
        sessionId,
        input: { type, ...pointer, button: "left", clickCount: 1 },
      });
    }
    expect({ dialog: await answer, out: await page().textContent("#out") }).toMatchObject({
      dialog: { type: "confirm", answered: true },
      out: "deleted",
    });
  });

  it("a prompt gets the text it is answered with, not null", async () => {
    await page().goto(`${site.url}/dialogs`);
    const ref = await refFor(/"Rename"/);
    const { answer } = await answerNextDialog(page(), { accept: true, promptText: "Renamed" });
    await browser.execute({ name: "browser.click", sessionId, ref });
    expect({ dialog: await answer, out: await page().textContent("#out") }).toMatchObject({
      dialog: { type: "prompt", message: "New name?", answered: true },
      out: "name: Renamed",
    });
  });

  it("an alert stays up until it is seen and closed", async () => {
    await page().goto(`${site.url}/dialogs`);
    const ref = await refFor(/"Notify"/);
    const { answer } = await answerNextDialog(page(), { accept: true });
    await browser.execute({ name: "browser.click", sessionId, ref });
    expect(await answer).toMatchObject({ type: "alert", message: "Saved!", answered: true });
  });

  const lastDialogs = () =>
    recorder.items.filter((i) => i.kind === "browser.dialogs" && i.sessionId === sessionId).at(-1);

  it("an agent sees the dialog its click opened, and answers it with browser.dialog", async () => {
    await page().goto(`${site.url}/dialogs`);
    const ref = await refFor(/"Delete"/);
    const clicked = await browser.handlers["browser.click"]({
      name: "browser.click",
      sessionId,
      ref,
    });
    const dialogId = clicked.dialog?.dialogId ?? "";
    const dialog = { dialogId, tabId: "t1", type: "confirm", message: "Delete this item?" };
    expect(clicked).toEqual({ dialog });
    expect(lastDialogs()).toEqual({ kind: "browser.dialogs", sessionId, dialogs: [dialog] });
    // The page is paused: a snapshot shows the dialog, and acting on the page is refused.
    const snap = await browser.handlers["browser.snapshot"]({
      name: "browser.snapshot",
      sessionId,
    });
    expect(snap).toMatchObject({ dialog, snapshot: "" });
    await expect(browser.execute({ name: "browser.click", sessionId, ref })).rejects.toMatchObject({
      code: "dialog_open",
    });

    const answered = await browser.execute({
      name: "browser.dialog",
      sessionId,
      dialogId,
      accept: true,
    });
    expect(answered).toEqual({ dialog });
    expect(lastDialogs()).toMatchObject({ dialogs: [], closed: { by: "agent", accepted: true } });
    expect(await page().textContent("#out")).toBe("deleted");
  });

  it("a viewer cancels a confirm the panel opened, and a prompt gets the agent's text", async () => {
    await page().goto(`${site.url}/dialogs`);
    const { width, height } = await manager.get(sessionId).currentViewport();
    const pointer = { x: 200, y: 120, frameWidth: width, frameHeight: height };
    for (const type of ["mouse.move", "mouse.down", "mouse.up"] as const) {
      await browser.execute({
        name: "browser.input",
        sessionId,
        input: { type, ...pointer, button: "left", clickCount: 1 },
      });
    }
    expect(lastDialogs()).toMatchObject({ dialogs: [{ type: "confirm" }] });
    const shown = manager.get(sessionId).dialogs.list()[0]?.dialogId ?? "";
    await browser.execute({
      name: "browser.dialog",
      sessionId,
      dialogId: shown,
      accept: false,
      by: "viewer",
    });
    expect(lastDialogs()).toMatchObject({ closed: { by: "viewer", accepted: false } });
    expect(await page().textContent("#out")).toBe("kept");

    const ref = await refFor(/"Rename"/);
    const clicked = await browser.handlers["browser.click"]({
      name: "browser.click",
      sessionId,
      ref,
    });
    expect(clicked.dialog).toMatchObject({ type: "prompt", defaultValue: "draft" });
    // The cancelled confirm's id no longer answers anything, not even this prompt.
    await expect(
      browser.execute({ name: "browser.dialog", sessionId, dialogId: shown, accept: true }),
    ).rejects.toMatchObject({ code: "no_dialog" });
    await browser.execute({
      name: "browser.dialog",
      sessionId,
      dialogId: clicked.dialog?.dialogId ?? "",
      accept: true,
      promptText: "Renamed",
    });
    expect(await page().textContent("#out")).toBe("name: Renamed");
  });

  it("CodeDen's own navigation is never held up by a page's 'Leave site?'", async () => {
    const asked: string[] = [];
    page().on("dialog", (d) => asked.push(d.type()));
    const touch = async () => {
      // beforeunload only asks after the user touched the page.
      await browser.execute({ name: "browser.click", sessionId, ref: await refFor(/textbox/) });
    };
    await page().goto(`${site.url}/leave`);
    await touch();
    const result = await browser.handlers["browser.navigate"]({
      name: "browser.navigate",
      sessionId,
      url: `${site.url}/page2`,
    });
    expect(result.url).toBe(`${site.url}/page2`);
    await page().goto(`${site.url}/leave`);
    await touch();
    await browser.execute({ name: "browser.history", sessionId, action: "reload" });
    expect(asked).toEqual(["beforeunload", "beforeunload"]);
    expect(manager.get(sessionId).dialogs.list()).toEqual([]);
  });
}

describe.skipIf(!hasBrowser)("page dialogs, runner engine (#183)", { timeout: 30_000 }, () =>
  dialogSuite("runner"),
);

describe.skipIf(!hasBrowser)("page dialogs, native engine (#183)", { timeout: 30_000 }, () =>
  dialogSuite("native"),
);
