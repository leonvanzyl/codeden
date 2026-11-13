import type {
  BrowserClientMessage,
  BrowserDialog,
  BrowserDialogClosed,
  BrowserServerMessage,
  BrowserTab,
} from "@codeden/contracts";
import type { WSContext } from "hono/ws";
import { describe, expect, it } from "vitest";
import { BrowserBridge } from "../src/realtime/browser";
import { AgentActivity } from "../src/services/browser/agent-activity";
import type { BrowserService } from "../src/services/browser/browser-service";
import { ServiceError } from "../src/services/errors";

const tab: BrowserTab = { tabId: "t1", url: "http://localhost:3000/", title: "App", active: true };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A bridge over a fake runner browser, with one connected viewer. */
async function setup() {
  const commands: Array<{ name: string; watching?: boolean }> = [];
  let open = true;
  const browser = {
    tabs: async () => ({ open, tabs: open ? [tab] : [] }),
    open: async () => {
      open = true;
      return { tabs: [tab] };
    },
    command: async (cmd: { name: string; watching?: boolean }) => {
      commands.push(cmd);
      return {};
    },
  } as unknown as BrowserService;
  const messages: BrowserServerMessage[] = [];
  const ws = {
    readyState: 1,
    raw: {},
    send: (data: string) => messages.push(JSON.parse(data) as BrowserServerMessage),
  } as unknown as WSContext;
  const bridge = new BrowserBridge({ browser });
  const events = bridge.handlers({ sessionId: "s1" });
  events.onOpen?.(new Event("open"), ws);
  await tick();
  await tick();
  return { bridge, messages, commands, setOpen: (v: boolean) => (open = v) };
}

/** A bridge over a fake runner that applies viewports (clamped like the runner) and tracks agents. */
function multiViewer() {
  const commands: Array<Record<string, unknown>> = [];
  const agentActivity = new AgentActivity(50);
  const browser = {
    agentActivity,
    tabs: async () => ({ open: true, tabs: [tab] }),
    open: async () => ({ tabs: [tab] }),
    command: async (cmd: Record<string, unknown>) => {
      commands.push(cmd);
      if (cmd.name === "browser.viewport") {
        return {
          width: Math.max(320, cmd.width as number),
          height: cmd.height,
          deviceScaleFactor: Math.min(2, cmd.deviceScaleFactor as number),
        };
      }
      return {};
    },
  } as unknown as BrowserService;
  const bridge = new BrowserBridge({ browser });
  const connect = async () => {
    const messages: BrowserServerMessage[] = [];
    const ws = {
      readyState: 1,
      raw: {},
      send: (data: string) => messages.push(JSON.parse(data) as BrowserServerMessage),
    } as unknown as WSContext;
    const events = bridge.handlers({ sessionId: "s1" });
    events.onOpen?.(new Event("open"), ws);
    await settle();
    const say = async (msg: BrowserClientMessage) => {
      events.onMessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }), ws);
      await settle();
    };
    const lastViewport = () =>
      messages.filter((m) => m.type === "viewport").at(-1) as
        | Extract<BrowserServerMessage, { type: "viewport" }>
        | undefined;
    return {
      messages,
      say,
      lastViewport,
      close: () => events.onClose?.(new CloseEvent("close"), ws),
    };
  };
  const viewports = () => commands.filter((c) => c.name === "browser.viewport");
  return { bridge, connect, viewports, agentActivity };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

describe("BrowserBridge viewport and agent activity", () => {
  it("sizes the page to the owning viewer and tells each viewer whether it is theirs", async () => {
    const { connect, viewports } = await multiViewer();
    const desk = await connect();
    await desk.say({ type: "viewport", width: 460, height: 712, deviceScaleFactor: 2 });
    expect(viewports().at(-1)).toMatchObject({ width: 460, height: 712, deviceScaleFactor: 2 });
    expect(desk.lastViewport()).toEqual({
      type: "viewport",
      width: 460,
      height: 712,
      deviceScaleFactor: 2,
      mine: true,
    });

    // A phone joins: the page keeps the desktop size; the phone hears it isn't its size.
    const phone = await connect();
    await phone.say({ type: "viewport", width: 390, height: 640, deviceScaleFactor: 3 });
    expect(viewports()).toHaveLength(1);
    expect(phone.lastViewport()).toMatchObject({ width: 460, mine: false });

    // The phone is used: it claims, the page follows it (scale clamped by the runner).
    await phone.say({
      type: "viewport",
      width: 390,
      height: 640,
      deviceScaleFactor: 3,
      claim: true,
    });
    expect(viewports().at(-1)).toMatchObject({ width: 390, height: 640 });
    expect(phone.lastViewport()).toMatchObject({ width: 390, deviceScaleFactor: 2, mine: true });
    expect(desk.lastViewport()).toMatchObject({ width: 390, mine: false });

    // The phone leaves: the desktop size comes back.
    phone.close();
    await settle();
    expect(viewports().at(-1)).toMatchObject({ width: 460, height: 712 });
    expect(desk.lastViewport()).toMatchObject({ width: 460, mine: true });
  });

  it("coalesces a burst of resizes into the latest size", async () => {
    const { connect, viewports } = await multiViewer();
    const desk = await connect();
    for (const width of [500, 520, 540, 560]) {
      void desk.say({ type: "viewport", width, height: 700, deviceScaleFactor: 1 });
    }
    await settle();
    expect(viewports().at(-1)).toMatchObject({ width: 560 });
    expect(viewports().length).toBeLessThanOrEqual(4);
    expect(desk.lastViewport()).toMatchObject({ width: 560, mine: true });
  });

  it("broadcasts agent activity to the session's viewers, including late joiners", async () => {
    const { connect, agentActivity } = await multiViewer();
    const a = await connect();
    agentActivity.begin("s1");
    expect(a.messages.at(-1)).toEqual({ type: "agent", acting: true });
    const b = await connect();
    expect(b.messages).toContainEqual({ type: "agent", acting: true });
    agentActivity.end("s1");
    await new Promise((r) => setTimeout(r, 80));
    expect(a.messages.at(-1)).toEqual({ type: "agent", acting: false });
    expect(b.messages.at(-1)).toEqual({ type: "agent", acting: false });
  });
});

describe("BrowserBridge frames", () => {
  it("delivers the current frame the runner replays while a viewer joins", async () => {
    let bridge: BrowserBridge | undefined;
    const browser = {
      tabs: async () => ({ open: true, tabs: [tab] }),
      open: async () => ({ tabs: [tab] }),
      command: async (cmd: { name: string; watching?: boolean }) => {
        // Like the runner: the last frame goes out on the stream before the command answers.
        if (cmd.name === "browser.screencast" && cmd.watching) {
          bridge?.onStream({
            kind: "browser.frame",
            sessionId: "s1",
            mediaType: "image/jpeg",
            data: "AA==",
            width: 10,
            height: 10,
          });
        }
        return {};
      },
    } as unknown as BrowserService;
    bridge = new BrowserBridge({ browser });
    const messages: BrowserServerMessage[] = [];
    const ws = {
      readyState: 1,
      raw: {},
      send: (data: string) => messages.push(JSON.parse(data) as BrowserServerMessage),
    } as unknown as WSContext;
    bridge.handlers({ sessionId: "s1" }).onOpen?.(new Event("open"), ws);
    await settle();
    expect(messages.some((m) => m.type === "frame")).toBe(true);
  });
});

/**
 * A bridge over a fake runner that lists its open dialogs, and fails a dialog answered twice like
 * the runner (`no_dialog`).
 */
function dialogBridge() {
  const commands: Array<Record<string, unknown>> = [];
  let answered = false;
  let open: BrowserDialog[] = [];
  const browser = {
    tabs: async () => ({ open: true, tabs: [tab], ...(open.length ? { dialogs: open } : {}) }),
    open: async () => ({ tabs: [tab] }),
    command: async (cmd: Record<string, unknown>) => {
      commands.push(cmd);
      if (cmd.name === "browser.dialog") {
        if (answered) throw new ServiceError(409, "no_dialog", "No dialog is open on tab t1");
        answered = true;
      }
      return {};
    },
  } as unknown as BrowserService;
  const bridge = new BrowserBridge({ browser });
  const connect = async () => {
    const messages: BrowserServerMessage[] = [];
    const ws = {
      readyState: 1,
      raw: {},
      send: (data: string) => messages.push(JSON.parse(data) as BrowserServerMessage),
    } as unknown as WSContext;
    const events = bridge.handlers({ sessionId: "s1" });
    events.onOpen?.(new Event("open"), ws);
    await settle();
    const say = async (msg: BrowserClientMessage) => {
      events.onMessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }), ws);
      await settle();
    };
    return { messages, say };
  };
  /** The runner's dialogs change, and it says so on the stream. */
  const update = (dialogs: BrowserDialog[], closed?: BrowserDialogClosed) => {
    open = dialogs;
    bridge.onStream({
      kind: "browser.dialogs",
      sessionId: "s1",
      dialogs,
      ...(closed && { closed }),
    });
  };
  return { bridge, connect, commands, update };
}

describe("BrowserBridge page dialogs", () => {
  it("shows dialogs to every viewer, late joiners too, and sends a viewer's answer", async () => {
    const { bridge, connect, commands, update } = dialogBridge();
    const desk = await connect();
    const dialog = { tabId: "t1", type: "confirm" as const, message: "Delete this item?" };
    update([dialog]);
    expect(desk.messages.at(-1)).toEqual({ type: "dialogs", dialogs: [dialog] });
    const phone = await connect();
    expect(phone.messages).toContainEqual({ type: "dialogs", dialogs: [dialog] });

    await phone.say({ type: "dialog", tabId: "t1", accept: true });
    expect(commands.at(-1)).toEqual({
      name: "browser.dialog",
      sessionId: "s1",
      tabId: "t1",
      accept: true,
      by: "viewer",
    });
    const closed = { ...dialog, by: "viewer" as const, accepted: true };
    update([], closed);
    expect(desk.messages.at(-1)).toEqual({ type: "dialogs", dialogs: [], closed });

    // A second answer to a dialog that is gone is not an error.
    await desk.say({ type: "dialog", tabId: "t1", accept: false });
    expect(desk.messages.some((m) => m.type === "error")).toBe(false);
    // A closed browser has no dialogs.
    update([dialog]);
    bridge.onStream({ kind: "browser.tabs", sessionId: "s1", tabs: [] });
    expect(desk.messages.at(-1)).toMatchObject({ type: "state", open: false });
    expect(desk.messages.at(-2)).toEqual({ type: "dialogs", dialogs: [] });
  });
});

describe("BrowserBridge", () => {
  it("detaches viewers with a closed state when the browser closes, and re-attaches on open", async () => {
    const { bridge, messages, commands, setOpen } = await setup();
    expect(messages.at(-1)).toMatchObject({ type: "state", open: true, watching: true });
    expect(commands.filter((c) => c.name === "browser.screencast")).toHaveLength(1);

    setOpen(false);
    bridge.onStream({ kind: "browser.tabs", sessionId: "s1", tabs: [] });
    expect(messages.at(-1)).toEqual({
      type: "state",
      viewerId: expect.any(String),
      open: false,
      watching: false,
      tabs: [],
    });
    // Detached: no frames reach it while closed.
    const before = messages.length;
    bridge.onStream({
      kind: "browser.frame",
      sessionId: "s1",
      mediaType: "image/jpeg",
      data: "AA==",
      width: 10,
      height: 10,
    });
    expect(messages.length).toBe(before);
    expect(bridge.viewerCount("s1")).toBe(1);

    setOpen(true);
    bridge.onStream({ kind: "browser.tabs", sessionId: "s1", tabs: [tab] });
    await tick();
    expect(commands.filter((c) => c.name === "browser.screencast" && c.watching)).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: "state", open: true, watching: true });
  });
});
