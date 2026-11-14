import { describe, expect, it } from "vitest";
import {
  BrowserInput,
  MAX_SELECT_VALUES,
  MAX_UPLOAD_FILES,
  RunnerCommand,
  RunnerCommandResults,
  RunnerStream,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
}

describe("browser protocol", () => {
  it("round-trips browser commands", () => {
    const commands: unknown[] = [
      { name: "browser.open", sessionId: "s1", url: "http://localhost:5173" },
      { name: "browser.navigate", sessionId: "s1", tabId: "t2", url: "localhost:3000" },
      { name: "browser.history", sessionId: "s1", action: "back" },
      { name: "browser.tabs.list", sessionId: "s1" },
      { name: "browser.tabs.open", sessionId: "s1" },
      { name: "browser.tabs.close", sessionId: "s1", tabId: "t1" },
      { name: "browser.tabs.activate", sessionId: "s1", tabId: "t1" },
      { name: "browser.viewport", sessionId: "s1", width: 1280, height: 800 },
      {
        name: "browser.viewport",
        sessionId: "s1",
        width: 460,
        height: 712,
        deviceScaleFactor: 1.5,
      },
      {
        name: "browser.screencast",
        sessionId: "s1",
        viewerId: "panel-1",
        watching: true,
        quality: 70,
        maxFps: 20,
      },
      { name: "browser.devServer", sessionId: "s1", port: 5173, path: "/app" },
      { name: "browser.snapshot", sessionId: "s1" },
      { name: "browser.click", sessionId: "s1", ref: "e12", doubleClick: true },
      { name: "browser.type", sessionId: "s1", ref: "f1e3", text: "hi", submit: true },
      { name: "browser.press", sessionId: "s1", key: "Control+A" },
      { name: "browser.screenshot", sessionId: "s1", path: "/tmp/a.png", fullPage: true },
      { name: "browser.logs", sessionId: "s1", kind: "network", since: 10, limit: 50 },
      { name: "browser.evaluate", sessionId: "s1", expression: "() => document.title" },
      { name: "browser.wait", sessionId: "s1", text: "Ready", timeoutMs: 1000 },
      { name: "browser.close", sessionId: "s1" },
    ];
    for (const command of commands) roundTrip(RunnerCommand, command);
    expect(() =>
      RunnerCommand.parse({ name: "browser.click", sessionId: "s1", ref: "button" }),
    ).toThrow();
  });

  it("round-trips agent pointer actions and checks their fields", () => {
    const actions: unknown[] = [
      { name: "browser.mouse", sessionId: "s1", action: "click", x: 150, y: 150.5 },
      {
        name: "browser.mouse",
        sessionId: "s1",
        tabId: "t2",
        action: "click",
        x: 1,
        y: 2,
        button: "right",
        clickCount: 2,
        modifiers: ["Shift", "Control"],
      },
      { name: "browser.mouse", sessionId: "s1", action: "hover", x: 560, y: 70 },
      {
        name: "browser.mouse",
        sessionId: "s1",
        action: "drag",
        x: 520,
        y: 220,
        toX: 620,
        toY: 270,
        modifiers: ["Alt"],
      },
      { name: "browser.mouse", sessionId: "s1", action: "scroll", x: 300, y: 300, deltaY: -400 },
      { name: "browser.mouse", sessionId: "s1", action: "scroll", x: 0, y: 0, deltaX: 120 },
    ];
    for (const action of actions) roundTrip(RunnerCommand, action);
    roundTrip(RunnerCommandResults["browser.mouse"], {});

    const base = { name: "browser.mouse", sessionId: "s1", x: 10, y: 10 };
    const refused: unknown[] = [
      { ...base, action: "drag", toX: 20 }, // no toY
      { ...base, action: "scroll" }, // no delta
      { ...base, action: "scroll", deltaX: 0, deltaY: 0 },
      { ...base, action: "scroll", deltaY: 10_001 },
      { ...base, action: "hover", clickCount: 2 }, // click-only field
      { ...base, action: "click", deltaY: 100 }, // scroll-only field
      { ...base, action: "scroll", deltaY: 100, button: "left" },
      { ...base, action: "click", toX: 1, toY: 1 },
      { ...base, action: "click", x: -1 },
      { ...base, action: "click", clickCount: 4 },
      { ...base, action: "click", modifiers: ["Super"] },
      { ...base, action: "tap" },
    ];
    for (const value of refused) expect(() => RunnerCommand.parse(value)).toThrow();
  });

  it("round-trips <select> choices and file uploads, with their limits", () => {
    const select = { name: "browser.select", sessionId: "s1", ref: "e3" };
    roundTrip(RunnerCommand, { ...select, values: ["Netherlands"] });
    roundTrip(RunnerCommand, { ...select, tabId: "t2", ref: "f1e4", values: ["za", "nl"] });
    roundTrip(RunnerCommand, { ...select, values: Array(MAX_SELECT_VALUES).fill("x") });
    for (const refused of [
      { ...select, values: [] },
      { ...select, values: Array(MAX_SELECT_VALUES + 1).fill("x") },
      { ...select, values: ["x".repeat(1_001)] },
      { ...select, ref: "select#country", values: ["nl"] },
    ]) {
      expect(() => RunnerCommand.parse(refused)).toThrow();
    }
    const dialog = { dialogId: "d0f", tabId: "t1", type: "confirm", message: "Switch country?" };
    roundTrip(RunnerCommandResults["browser.select"], {
      selected: [{ value: "nl", label: "Netherlands" }],
    });
    roundTrip(RunnerCommandResults["browser.select"], { selected: [] });
    roundTrip(RunnerCommandResults["browser.select"], {
      selected: [{ value: "price", label: "Price" }],
      detached: true,
    });
    roundTrip(RunnerCommandResults["browser.select"], { dialog });

    const upload = { name: "browser.upload", sessionId: "s1", ref: "e5" };
    roundTrip(RunnerCommand, { ...upload, paths: ["/work/repo/fixtures/data.csv"] });
    roundTrip(RunnerCommand, { ...upload, tabId: "t1", paths: ["C:\\wt\\a.png", "C:\\wt\\b.png"] });
    for (const refused of [
      { ...upload, paths: [] },
      { ...upload, paths: [""] },
      { ...upload, paths: Array(MAX_UPLOAD_FILES + 1).fill("/tmp/a.csv") },
      { ...upload, paths: ["/tmp/a.csv"], ref: undefined },
    ]) {
      expect(() => RunnerCommand.parse(refused)).toThrow();
    }
    roundTrip(RunnerCommandResults["browser.upload"], { via: "input" });
    roundTrip(RunnerCommandResults["browser.upload"], { via: "chooser" });
    roundTrip(RunnerCommandResults["browser.upload"], { dialog, via: "input" });
    roundTrip(RunnerCommandResults["browser.upload"], { dialog });
    expect(() => RunnerCommandResults["browser.upload"].parse({ via: "drop" })).toThrow();
  });

  it("types at the focused element without a ref, up to a cap", () => {
    roundTrip(RunnerCommand, { name: "browser.type", sessionId: "s1", text: "hi", submit: true });
    roundTrip(RunnerCommand, { name: "browser.type", sessionId: "s1", text: "x".repeat(2_000) });
    expect(() =>
      RunnerCommand.parse({ name: "browser.type", sessionId: "s1", text: "x".repeat(2_001) }),
    ).toThrow();
    // A ref still fills, with the long limit.
    roundTrip(RunnerCommand, {
      name: "browser.type",
      sessionId: "s1",
      ref: "e3",
      text: "x".repeat(5_000),
    });
  });

  it("round-trips forwarded input", () => {
    roundTrip(RunnerCommand, {
      name: "browser.input",
      sessionId: "s1",
      input: {
        type: "mouse.down",
        x: 10,
        y: 20,
        frameWidth: 640,
        frameHeight: 400,
        button: "left",
        clickCount: 1,
        modifiers: 8,
      },
    });
    roundTrip(BrowserInput, {
      type: "mouse.wheel",
      x: 230,
      y: 300,
      frameWidth: 920,
      frameHeight: 1424,
      viewportWidth: 460,
      viewportHeight: 712,
      deltaY: 100,
    });
    expect(() =>
      RunnerCommand.parse({
        name: "browser.viewport",
        sessionId: "s1",
        width: 800,
        height: 600,
        deviceScaleFactor: 0,
      }),
    ).toThrow();
    roundTrip(RunnerCommandResults["browser.viewport"], {
      width: 460,
      height: 712,
      deviceScaleFactor: 2,
    });
    roundTrip(RunnerCommandResults["browser.viewport"], {});
    roundTrip(BrowserInput, { type: "key.down", key: "a", code: "KeyA", text: "a" });
    roundTrip(BrowserInput, { type: "text.insert", text: "hello" });
    expect(() => BrowserInput.parse({ type: "mouse.move", x: 1, y: 1 })).toThrow();
  });

  it("round-trips results and stream data", () => {
    const tab = { tabId: "t1", url: "about:blank", title: "", active: true };
    roundTrip(RunnerCommandResults["browser.open"], { cdpUrl: "ws://127.0.0.1:1/x", tabs: [tab] });
    roundTrip(RunnerCommandResults["browser.open"], { cdpUrl: null });
    roundTrip(RunnerCommandResults["browser.logs"], {
      console: [{ id: 1, tabId: "t1", level: "log", text: "hi", ts: "2026-01-01T00:00:00Z" }],
      network: [
        {
          id: 2,
          tabId: "t1",
          method: "GET",
          url: "http://x/",
          resourceType: "document",
          status: 200,
          failure: null,
          ts: "2026-01-01T00:00:00Z",
          durationMs: 12,
        },
      ],
    });
    roundTrip(RunnerStream, {
      kind: "browser.frame",
      sessionId: "s1",
      tabId: "t1",
      mediaType: "image/jpeg",
      data: "AAAA",
      width: 640,
      height: 400,
      metadata: {
        timestamp: 1,
        deviceWidth: 1280,
        deviceHeight: 800,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
    // Frames without the new optional fields stay valid.
    roundTrip(RunnerStream, {
      kind: "browser.frame",
      sessionId: "s1",
      mediaType: "image/png",
      data: "AAAA",
      width: 1,
      height: 1,
    });
    roundTrip(RunnerStream, { kind: "browser.tabs", sessionId: "s1", tabs: [tab] });
    roundTrip(RunnerStream, { kind: "browser.tabs", sessionId: "s1", tabs: [], engine: "native" });
  });

  it("round-trips page dialogs: answers, action results, snapshots and stream data", () => {
    const dialog = { dialogId: "d0f", tabId: "t1", type: "confirm", message: "Delete this item?" };
    const prompt = {
      dialogId: "d1e",
      tabId: "t2",
      type: "prompt",
      message: "New name?",
      defaultValue: "draft",
    };
    const answer = { name: "browser.dialog", sessionId: "s1", dialogId: "d0f" };
    roundTrip(RunnerCommand, { ...answer, accept: true });
    roundTrip(RunnerCommand, { ...answer, accept: true, promptText: "Renamed", by: "viewer" });
    expect(() => RunnerCommand.parse({ ...answer, accept: true, by: "timeout" })).toThrow();
    expect(() => RunnerCommand.parse(answer)).toThrow();
    // An answer always names its dialog: never just a tab.
    expect(() =>
      RunnerCommand.parse({ name: "browser.dialog", sessionId: "s1", tabId: "t1", accept: true }),
    ).toThrow();
    expect(() => RunnerCommand.parse({ ...answer, dialogId: "d 1", accept: true })).toThrow();
    roundTrip(RunnerCommandResults["browser.dialog"], { dialog: prompt });
    for (const name of [
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.mouse",
    ] as const) {
      roundTrip(RunnerCommandResults[name], {});
      roundTrip(RunnerCommandResults[name], { dialog });
    }
    roundTrip(RunnerCommandResults["browser.snapshot"], {
      tabId: "t1",
      url: "http://localhost:5173/",
      title: "Items",
      snapshot: "",
      truncated: false,
      dialog,
    });
    roundTrip(RunnerCommandResults["browser.tabs.list"], { tabs: [], dialogs: [dialog, prompt] });
    roundTrip(RunnerStream, { kind: "browser.dialogs", sessionId: "s1", dialogs: [dialog] });
    roundTrip(RunnerStream, {
      kind: "browser.dialogs",
      sessionId: "s1",
      dialogs: [],
      closed: { ...dialog, by: "timeout", accepted: false },
    });
    expect(() =>
      RunnerStream.parse({
        kind: "browser.dialogs",
        sessionId: "s1",
        dialogs: [{ ...dialog, type: "print" }],
      }),
    ).toThrow();
  });

  it("round-trips the native engine: relay opens, hand-off and fixed viewports", () => {
    const relay = { url: "ws://127.0.0.1:50123/cdp/s1", secret: "f".repeat(64) };
    roundTrip(RunnerCommand, { name: "browser.open", sessionId: "s1", relay });
    roundTrip(RunnerCommand, {
      name: "browser.handoff",
      sessionId: "s1",
      tabs: [{ url: "http://localhost:5173/", active: true }],
      cookies: [
        {
          name: "sid",
          value: "1",
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
        },
      ],
    });
    expect(() =>
      RunnerCommand.parse({
        name: "browser.open",
        sessionId: "s1",
        relay: { ...relay, url: "ws://10.0.0.2:50123/cdp/s1" },
      }),
    ).toThrow();
    const tab = { tabId: "t1", url: "http://localhost:5173/", title: "App", active: true };
    roundTrip(RunnerCommandResults["browser.open"], {
      cdpUrl: null,
      tabs: [tab],
      engine: "native",
    });
    roundTrip(RunnerCommandResults["browser.handoff"], { tabs: [tab] });
    roundTrip(RunnerCommandResults["browser.tabs.list"], { tabs: [tab], engine: "runner" });
    roundTrip(RunnerCommandResults["browser.viewport"], {
      width: 900,
      height: 700,
      deviceScaleFactor: 1.5,
      fixed: true,
    });
  });
});
