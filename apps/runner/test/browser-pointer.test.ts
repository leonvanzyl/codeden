import { describe, expect, it } from "vitest";
import {
  dragSteps,
  type MouseCommand,
  mouse,
  mouseAction,
  type PointerPage,
} from "../src/browser/pointer";
import type { BrowserSession } from "../src/browser/session";
import { CommandError } from "../src/errors";

/**
 * A page that records the mouse and keyboard calls it gets. A call `fail` matches (by its
 * recorded text, e.g. `mouse.down({})`) is recorded first, then rejects, as Playwright marks a
 * button or key held before the press it dispatches fails.
 */
function fakePage(fail?: (call: string) => boolean) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      const shown = args.filter((a) => a !== undefined).map((a) => JSON.stringify(a));
      const call = `${name}(${shown.join(", ")})`;
      calls.push(call);
      if (fail?.(call)) throw new Error(`${name} broke\nstack`);
    };
  const page = {
    mouse: {
      click: record("mouse.click"),
      down: record("mouse.down"),
      move: record("mouse.move"),
      up: record("mouse.up"),
      wheel: record("mouse.wheel"),
    },
    keyboard: { down: record("keyboard.down"), up: record("keyboard.up") },
    evaluate: async () => {
      calls.push("settle");
      return true;
    },
  } as unknown as PointerPage;
  return { page, calls };
}

const viewport = { width: 1000, height: 700 };
const run = (page: PointerPage, command: MouseCommand) => mouseAction(page, command, viewport);

describe("agent pointer actions", () => {
  it("clicks at the point with the button and click count", async () => {
    const { page, calls } = fakePage();
    await run(page, { action: "click", x: 150, y: 150 });
    await run(page, { action: "click", x: 10.5, y: 20, button: "right", clickCount: 2 });
    expect(calls).toEqual([
      'mouse.click(150, 150, {"clickCount":1})',
      'mouse.click(10.5, 20, {"button":"right","clickCount":2})',
    ]);
  });

  it("hovers by moving the pointer and leaving it there", async () => {
    const { page, calls } = fakePage();
    await run(page, { action: "hover", x: 560, y: 70 });
    expect(calls).toEqual(["mouse.move(560, 70)"]);
  });

  it("drags: press at the start, move to the end in steps, release", async () => {
    const { page, calls } = fakePage();
    await run(page, { action: "drag", x: 520, y: 220, toX: 620, toY: 270 });
    expect(calls).toEqual([
      "mouse.move(520, 220)",
      "mouse.down({})",
      'mouse.move(620, 270, {"steps":6})',
      "mouse.up({})",
    ]);
  });

  it("scrolls with the wheel at the point, then waits for the page to settle", async () => {
    const { page, calls } = fakePage();
    await run(page, { action: "scroll", x: 300, y: 300, deltaY: 400 });
    expect(calls).toEqual(["mouse.move(300, 300)", "mouse.wheel(0, 400)", "settle"]);
  });

  it("holds modifiers for the action and releases them in reverse order", async () => {
    const { page, calls } = fakePage();
    await run(page, { action: "click", x: 1, y: 1, modifiers: ["Shift", "Control"] });
    expect(calls).toEqual([
      'keyboard.down("Shift")',
      'keyboard.down("Control")',
      'mouse.click(1, 1, {"clickCount":1})',
      'keyboard.up("Control")',
      'keyboard.up("Shift")',
    ]);
  });

  it("releases the button and the modifiers when a drag fails midway", async () => {
    const drag = { action: "drag", x: 1, y: 1, toX: 200, toY: 1 } as const;
    const first = fakePage((c) => c === "mouse.move(1, 1)");
    // The first move (to the start) fails: nothing was pressed yet, modifiers are released.
    await expect(run(first.page, { ...drag, modifiers: ["Alt"] })).rejects.toMatchObject({
      code: "action_failed",
      message: "Mouse drag at (1, 1) failed: mouse.move broke",
    });
    expect(first.calls).toEqual(['keyboard.down("Alt")', "mouse.move(1, 1)", 'keyboard.up("Alt")']);

    // The move to the end fails after the press: the button is released too.
    const second = fakePage((c) => c.startsWith("mouse.move(200"));
    await expect(run(second.page, { ...drag, button: "middle" })).rejects.toMatchObject({
      code: "action_failed",
    });
    expect(second.calls).toEqual([
      "mouse.move(1, 1)",
      'mouse.down({"button":"middle"})',
      'mouse.move(200, 1, {"steps":10})',
      'mouse.up({"button":"middle"})',
    ]);
  });

  it("releases a button whose press itself failed, keeping the press's error", async () => {
    // A drag's press fails: the button may already count as held, so it is released.
    const drag = fakePage((c) => c.startsWith("mouse.down"));
    await expect(
      run(drag.page, { action: "drag", x: 1, y: 1, toX: 200, toY: 1, modifiers: ["Alt"] }),
    ).rejects.toMatchObject({
      code: "action_failed",
      message: "Mouse drag at (1, 1) failed: mouse.down broke",
    });
    expect(drag.calls).toEqual([
      'keyboard.down("Alt")',
      "mouse.move(1, 1)",
      "mouse.down({})",
      "mouse.up({})",
      'keyboard.up("Alt")',
    ]);

    // A click presses inside Playwright's own click: a failed click releases its button too.
    const click = fakePage((c) => c.startsWith("mouse.click"));
    await expect(
      run(click.page, { action: "click", x: 5, y: 6, button: "right" }),
    ).rejects.toMatchObject({ message: "Mouse click at (5, 6) failed: mouse.click broke" });
    expect(click.calls).toEqual([
      'mouse.click(5, 6, {"button":"right","clickCount":1})',
      'mouse.up({"button":"right"})',
    ]);
  });

  it("releases a modifier whose press failed, and the ones pressed before it", async () => {
    const only = fakePage((c) => c.startsWith("keyboard.down"));
    await expect(
      run(only.page, { action: "click", x: 1, y: 1, modifiers: ["Shift"] }),
    ).rejects.toMatchObject({ message: "Mouse click at (1, 1) failed: keyboard.down broke" });
    expect(only.calls).toEqual(['keyboard.down("Shift")', 'keyboard.up("Shift")']);

    // The second key fails after the first succeeded; releases failing too can't hide the error.
    const second = fakePage((c) => c === 'keyboard.down("Control")' || c.startsWith("keyboard.up"));
    await expect(
      run(second.page, { action: "hover", x: 1, y: 1, modifiers: ["Shift", "Control"] }),
    ).rejects.toMatchObject({ message: "Mouse hover at (1, 1) failed: keyboard.down broke" });
    expect(second.calls).toEqual([
      'keyboard.down("Shift")',
      'keyboard.down("Control")',
      'keyboard.up("Control")',
      'keyboard.up("Shift")',
    ]);
  });

  it("refuses points outside the viewport, naming its size", async () => {
    const { page, calls } = fakePage();
    for (const command of [
      { action: "click", x: 1000, y: 10 },
      { action: "hover", x: 10, y: 700.5 },
      { action: "click", x: -1, y: 10 },
      { action: "drag", x: 10, y: 10, toX: 10, toY: 900 },
    ] satisfies MouseCommand[]) {
      await expect(run(page, command)).rejects.toMatchObject({
        code: "out_of_bounds",
        message: expect.stringMatching(
          /outside the viewport \(1000x700 CSS pixels\)\. Take a new browser_screenshot\./,
        ),
      });
    }
    // Nothing reached the page.
    expect(calls).toEqual([]);
  });

  it("sends nothing to the target tab when its viewport can't be measured", async () => {
    const { page, calls } = fakePage();
    const tabs: Array<string | undefined> = [];
    const session = {
      page: () => page,
      currentViewport: async (tabId?: string) => {
        tabs.push(tabId);
        throw new CommandError("viewport_unavailable", "Could not measure the size of tab t2");
      },
    } as unknown as BrowserSession;
    await expect(
      mouse(session, { action: "drag", x: 1, y: 1, toX: 5, toY: 5, tabId: "t2" }),
    ).rejects.toMatchObject({ code: "viewport_unavailable" });
    // The target tab's own size was asked for, and nothing reached the page.
    expect(tabs).toEqual(["t2"]);
    expect(calls).toEqual([]);
  });

  it("takes about one drag step per 20 px, within 5 and 50", () => {
    expect(dragSteps({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
    expect(dragSteps({ x: 0, y: 0 }, { x: 300, y: 400 })).toBe(25);
    expect(dragSteps({ x: 0, y: 0 }, { x: 5000, y: 0 })).toBe(50);
  });
});
