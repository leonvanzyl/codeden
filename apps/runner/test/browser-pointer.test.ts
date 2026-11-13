import { describe, expect, it } from "vitest";
import {
  dragSteps,
  type MouseCommand,
  mouseAction,
  type PointerPage,
} from "../src/browser/pointer";

/** A page that records the mouse and keyboard calls it gets; `fail` makes one of them throw. */
function fakePage(fail?: string) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      const shown = args.filter((a) => a !== undefined).map((a) => JSON.stringify(a));
      calls.push(`${name}(${shown.join(", ")})`);
      if (fail && name === fail) throw new Error(`${name} broke\nstack`);
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
    const { page, calls } = fakePage("mouse.move");
    // The first move (to the start) fails: nothing was pressed yet, modifiers are released.
    await expect(
      run(page, { action: "drag", x: 1, y: 1, toX: 200, toY: 1, modifiers: ["Alt"] }),
    ).rejects.toMatchObject({
      code: "action_failed",
      message: "Mouse drag at (1, 1) failed: mouse.move broke",
    });
    expect(calls).toEqual(['keyboard.down("Alt")', "mouse.move(1, 1)", 'keyboard.up("Alt")']);

    // The move to the end fails after the press: the button is released too.
    let moves = 0;
    const second = fakePage();
    const move = second.page.mouse.move;
    second.page.mouse.move = async (...args: Parameters<typeof move>) => {
      await move(...args);
      if (++moves === 2) throw new Error("page closed");
    };
    await expect(
      run(second.page, { action: "drag", x: 1, y: 1, toX: 200, toY: 1, button: "middle" }),
    ).rejects.toMatchObject({ code: "action_failed" });
    expect(second.calls).toEqual([
      "mouse.move(1, 1)",
      'mouse.down({"button":"middle"})',
      'mouse.move(200, 1, {"steps":10})',
      'mouse.up({"button":"middle"})',
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

  it("takes about one drag step per 20 px, within 5 and 50", () => {
    expect(dragSteps({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
    expect(dragSteps({ x: 0, y: 0 }, { x: 300, y: 400 })).toBe(25);
    expect(dragSteps({ x: 0, y: 0 }, { x: 5000, y: 0 })).toBe(50);
  });
});
