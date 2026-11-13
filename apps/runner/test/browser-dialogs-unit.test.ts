import { EventEmitter } from "node:events";
import { DIALOG_TIMEOUT_MS, type RunnerStream } from "@codeden/contracts";
import type { BrowserContext } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserCommandHandlers,
  type BrowserManager,
  BrowserSession,
  createBrowserCommandHandlers,
  DEFAULT_VIEWPORT,
} from "../src/browser";

/** A Playwright CDP session that answers every command and records what was sent. */
class FakeCdp extends EventEmitter {
  readonly sent: string[] = [];
  async send(method: string): Promise<object> {
    this.sent.push(method);
    return {};
  }
}

/** A page dialog as Playwright hands it over. */
function fakeDialog(page: FakePage, type: string, message: string, defaultValue = "") {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    page: () => page,
    accept: vi.fn(async (_promptText?: string) => undefined),
    dismiss: vi.fn(async () => undefined),
  };
}

/** A page whose button opens a dialog when clicked; the click then waits for the answer. */
class FakePage extends EventEmitter {
  readonly cdp = new FakeCdp();
  onClick: () => void = () => undefined;
  constructor(private readonly context: FakeContext) {
    super();
  }
  url = () => "http://localhost:5173/items";
  title = async () => "Items";
  isClosed = () => false;
  mainFrame = () => ({});
  bringToFront = async () => undefined;
  goto = async () => null;
  getByRef = () => ({
    count: async () => 1,
    click: () => {
      this.onClick();
      // Like a real click on a confirm: done only once the dialog is answered.
      return new Promise<void>(() => undefined);
    },
  });
  /** The page calls `confirm(message)` (or another dialog). */
  open(type: string, message: string, defaultValue?: string) {
    const dialog = fakeDialog(this, type, message, defaultValue);
    this.context.emit("dialog", dialog);
    return dialog;
  }
}

class FakeContext extends EventEmitter {
  readonly page = new FakePage(this);
  setDefaultTimeout = () => undefined;
  setDefaultNavigationTimeout = () => undefined;
  pages = () => [];
  newPage = async () => this.page;
  newCDPSession = async (page: FakePage) => page.cdp;
  close = async () => undefined;
}

const sessionId = "s1";

describe("page dialogs (fake page)", () => {
  let context: FakeContext;
  let streams: RunnerStream[];
  let session: BrowserSession;
  let browser: BrowserCommandHandlers;

  beforeEach(async () => {
    context = new FakeContext();
    streams = [];
    session = new BrowserSession({
      sessionId,
      context: context as unknown as BrowserContext,
      viewport: DEFAULT_VIEWPORT,
      stream: (s) => streams.push(s),
      timeoutMs: 1_000,
    });
    const manager = { get: () => session, has: () => true } as unknown as BrowserManager;
    browser = createBrowserCommandHandlers({ manager });
    await session.openTab();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const dialogStreams = () =>
    streams.filter((s): s is Extract<RunnerStream, { kind: "browser.dialogs" }> => {
      return s.kind === "browser.dialogs";
    });

  /** The id of the dialog open now (the one the last update listed). */
  const openId = () => session.dialogs.list()[0]?.dialogId ?? "none";
  const answer = (dialogId: string, accept: boolean, extra: object = {}) =>
    browser.execute({ name: "browser.dialog", sessionId, dialogId, accept, ...extra });

  it("holds a confirm open until the agent accepts it", async () => {
    const dialog = context.page.open("confirm", "Delete this item?");
    const open = {
      dialogId: expect.stringMatching(/^d[0-9a-f]{8}$/),
      tabId: "t1",
      type: "confirm",
      message: "Delete this item?",
    };
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(dialogStreams()).toEqual([{ kind: "browser.dialogs", sessionId, dialogs: [open] }]);
    const id = openId();

    // The paused page is not acted on; a snapshot shows the dialog instead.
    const snap = await browser.handlers["browser.snapshot"]({
      name: "browser.snapshot",
      sessionId,
    });
    expect(snap).toMatchObject({ dialog: open, snapshot: "" });
    await expect(
      browser.execute({ name: "browser.click", sessionId, ref: "e1" }),
    ).rejects.toMatchObject({ code: "dialog_open" });

    const answered = await answer(id, true);
    expect(answered).toEqual({ dialog: { ...open, dialogId: id } });
    expect(dialog.accept).toHaveBeenCalledTimes(1);
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(dialogStreams().at(-1)).toEqual({
      kind: "browser.dialogs",
      sessionId,
      dialogs: [],
      closed: { ...open, dialogId: id, by: "agent", accepted: true },
    });
    await expect(answer(id, true)).rejects.toMatchObject({ code: "no_dialog" });
  });

  it("never lets a late answer for one dialog answer the next one on the same tab", async () => {
    // The agent and the person both answer "Show details?"; the agent is first, and the page
    // asks the next question at once.
    const first = context.page.open("confirm", "Show details?");
    const shown = openId();
    await answer(shown, true);
    const next = context.page.open("confirm", "Permanently delete all items?");
    expect(openId()).not.toBe(shown);

    // The person's answer, meant for "Show details?", arrives now: refused, the next one waits.
    await expect(answer(shown, true, { by: "viewer" })).rejects.toMatchObject({
      code: "no_dialog",
    });
    expect(first.accept).toHaveBeenCalledTimes(1);
    expect(next.accept).not.toHaveBeenCalled();
    expect(next.dismiss).not.toHaveBeenCalled();
    expect(session.dialogs.list()).toMatchObject([{ message: "Permanently delete all items?" }]);
    expect(() => session.dialogs.assertNone("t1")).toThrow(/dialogId "d[0-9a-f]{8}"/);
  });

  it("returns an agent's click as soon as it opens a dialog", async () => {
    context.page.onClick = () => context.page.open("prompt", "New name?", "draft");
    const clicked = await browser.handlers["browser.click"]({
      name: "browser.click",
      sessionId,
      ref: "e1",
    });
    expect(clicked).toEqual({
      dialog: {
        dialogId: openId(),
        tabId: "t1",
        type: "prompt",
        message: "New name?",
        defaultValue: "draft",
      },
    });
    expect(session.dialogs.list()).toHaveLength(1);
  });

  it("lets a viewer cancel a confirm, and drops panel input while one is open", async () => {
    const dialog = context.page.open("confirm", "Discard changes?");
    const before = context.page.cdp.sent.length;
    const at = { x: 10, y: 10, frameWidth: 1280, frameHeight: 800, button: "left" as const };
    await browser.execute({
      name: "browser.input",
      sessionId,
      input: { type: "mouse.down", ...at },
    });
    expect(context.page.cdp.sent.slice(before)).toEqual([]);

    await answer(openId(), false, { by: "viewer" });
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialogStreams().at(-1)?.closed).toMatchObject({ by: "viewer", accepted: false });
  });

  it("answers a prompt with the given text, or its own default", async () => {
    const first = context.page.open("prompt", "New name?", "draft");
    await answer(openId(), true, { promptText: "Shed" });
    expect(first.accept).toHaveBeenCalledWith("Shed");
    const second = context.page.open("prompt", "New name?", "draft");
    await answer(openId(), true);
    expect(second.accept).toHaveBeenCalledWith("draft");
  });

  it("dismisses a dialog nobody answers after the timeout, and says so", async () => {
    vi.useFakeTimers();
    const dialog = context.page.open("alert", "Saved!");
    vi.advanceTimersByTime(DIALOG_TIMEOUT_MS - 1);
    expect(dialog.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialogStreams().at(-1)).toMatchObject({
      dialogs: [],
      closed: { type: "alert", message: "Saved!", by: "timeout", accepted: false },
    });
  });

  it("accepts a 'Leave site?' during CodeDen's own navigation, and holds one otherwise", async () => {
    let leave: ReturnType<FakePage["open"]> | undefined;
    context.page.goto = async () => {
      leave = context.page.open("beforeunload", "");
      return null;
    };
    await browser.execute({ name: "browser.navigate", sessionId, url: "http://localhost:5173/" });
    expect(leave?.accept).toHaveBeenCalledTimes(1);
    expect(dialogStreams()).toEqual([]);

    // The page navigates itself (a link): the person decides.
    const held = context.page.open("beforeunload", "");
    expect(held.accept).not.toHaveBeenCalled();
    expect(session.dialogs.list()).toEqual([
      { dialogId: openId(), tabId: "t1", type: "beforeunload", message: "" },
    ]);
  });

  it("forgets a dialog the browser closed (answered in the desktop app's own dialog box)", async () => {
    context.page.open("confirm", "Delete this item?");
    // The tab's CDP session reports it: wait for its listener to be on.
    await vi.waitFor(() => expect(context.page.cdp.sent).toContain("Page.enable"));
    context.page.cdp.emit("Page.javascriptDialogClosed", { result: true, userInput: "" });
    expect(session.dialogs.list()).toEqual([]);
    expect(dialogStreams().at(-1)?.closed).toMatchObject({ by: "browser", accepted: true });
  });
});
