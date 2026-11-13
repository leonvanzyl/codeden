import {
  BrowserModifierKey,
  BrowserMouseAction,
  checkBrowserMouse,
  MAX_AGENT_SCROLL,
} from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../define";

/**
 * `browser_mouse` (§12.2, computer use step 1): act at pixel coordinates in the session's
 * browser, for what the accessibility snapshot can't reach (canvases, maps, charts, drag
 * handles, custom sliders, games, hover menus). Coordinates are viewport CSS pixels: the pixels
 * of a viewport `browser_screenshot`.
 */

const coordinate = z.number().min(0).max(100_000);
const scroll = z.number().min(-MAX_AGENT_SCROLL).max(MAX_AGENT_SCROLL);

const at = (x: number, y: number) => `(${Math.round(x * 100) / 100}, ${Math.round(y * 100) / 100})`;

export const browserMouse = defineTool({
  name: "browser_mouse",
  description:
    "Act at pixel coordinates in your session's browser: click, hover, drag or scroll. Coordinates are the pixels of a viewport browser_screenshot (not fullPage), origin top-left, which are the page's CSS pixels (the units of getBoundingClientRect). Use it for what browser_snapshot has no useful ref for: canvases, maps, charts, drag handles, custom sliders, games and hover menus; prefer browser_click and browser_type when there is a ref. Take a new screenshot after the page changes; to type after clicking into a field, use browser_type without a ref.",
  roles: ["agent"],
  scope: "session",
  input: z
    .object({
      action: BrowserMouseAction.describe(
        "click; hover (move the pointer there and leave it); drag (press at x,y, move to toX,toY, release); scroll (wheel at x,y by deltaX/deltaY)",
      ),
      x: coordinate.describe("X in viewport CSS pixels (a drag's start)"),
      y: coordinate.describe("Y in viewport CSS pixels (a drag's start)"),
      toX: coordinate.optional().describe("drag: where the drag ends (X)"),
      toY: coordinate.optional().describe("drag: where the drag ends (Y)"),
      deltaX: scroll.optional().describe("scroll: CSS pixels to the right (negative: left)"),
      deltaY: scroll.optional().describe("scroll: CSS pixels down (negative: up)"),
      button: z
        .enum(["left", "middle", "right"])
        .optional()
        .describe("click and drag: mouse button (default left)"),
      clickCount: z
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("click: 2 for a double click, 3 for a triple click (default 1)"),
      modifiers: z
        .array(BrowserModifierKey)
        .max(4)
        .optional()
        .describe("Keys held during the action, e.g. Shift for shift-click"),
      tabId: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Tab id (t1, t2, ...); default: the active tab"),
    })
    .superRefine(checkBrowserMouse),
  handler: async (input, { services, sessionId }) => {
    await services.browser.agentCommand({ name: "browser.mouse", sessionId, ...input });
    const held = input.modifiers?.length ? ` with ${input.modifiers.join("+")}` : "";
    switch (input.action) {
      case "click": {
        const kind = ["Clicked", "Double-clicked", "Triple-clicked"][(input.clickCount ?? 1) - 1];
        const button = input.button && input.button !== "left" ? ` (${input.button} button)` : "";
        return `${kind} at ${at(input.x, input.y)}${button}${held}.`;
      }
      case "hover":
        return `Hovering at ${at(input.x, input.y)}${held}.`;
      case "drag":
        return `Dragged from ${at(input.x, input.y)} to ${at(input.toX ?? 0, input.toY ?? 0)}${held}.`;
      case "scroll":
        return `Scrolled by ${at(input.deltaX ?? 0, input.deltaY ?? 0)} at ${at(input.x, input.y)}${held}.`;
    }
  },
});
