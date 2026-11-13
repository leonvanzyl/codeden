import type { BrowserModifierKey, BrowserMouseAction } from "@codeden/contracts";
import type { Page } from "playwright-core";
import { CommandError } from "../errors";
import type { ViewportSize } from "./input";
import type { BrowserSession } from "./session";

/**
 * Agent pointer actions at page coordinates (§12.2 computer use, step 1). Coordinates are CSS
 * pixels of the tab's viewport, the pixels of a viewport screenshot. Playwright's mouse sends
 * CDP `Input.dispatchMouseEvent`, so this works the same on the runner's Chromium and on native
 * views behind the desktop app's relay.
 */

/** The parts of a Playwright page a pointer action uses (a fake one in unit tests). */
export interface PointerPage {
  mouse: Pick<Page["mouse"], "click" | "down" | "move" | "up" | "wheel">;
  keyboard: Pick<Page["keyboard"], "down" | "up">;
  evaluate(expression: string): Promise<unknown>;
}

/** A `browser.mouse` command without its routing fields. */
export interface MouseCommand {
  action: BrowserMouseAction;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  modifiers?: BrowserModifierKey[];
}

interface Point {
  x: number;
  y: number;
}

/** Drags move in about one step per this many CSS pixels, so drag thresholds see motion. */
const DRAG_STEP_PX = 20;
const MIN_DRAG_STEPS = 5;
const MAX_DRAG_STEPS = 50;
/** A scroll returns once no scroll event came for this long (smooth scrolling has ended). */
const SCROLL_QUIET_MS = 100;
/** ... or after this long in the page, whatever happens. */
const SCROLL_SETTLE_MAX_MS = 1_000;
/** The runner stops waiting for the page itself after this (a busy or hidden page). */
const SCROLL_SETTLE_TIMEOUT_MS = 1_500;

/**
 * Resolves once the page has had no `scroll` event (on any scroller: captured on `window`) for
 * `SCROLL_QUIET_MS`, at most `SCROLL_SETTLE_MAX_MS` (a timer too: hidden tabs get no animation
 * frames). A string, so it runs in the page's realm.
 */
const SCROLL_SETTLED = `new Promise((resolve) => {
  const start = performance.now();
  let last = start;
  const onScroll = () => { last = performance.now(); };
  const done = () => {
    removeEventListener("scroll", onScroll, { capture: true });
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(done, ${SCROLL_SETTLE_MAX_MS});
  addEventListener("scroll", onScroll, { capture: true, passive: true });
  const tick = () => {
    const now = performance.now();
    if (now - last < ${SCROLL_QUIET_MS} && now - start < ${SCROLL_SETTLE_MAX_MS}) {
      requestAnimationFrame(tick);
    } else done();
  };
  requestAnimationFrame(tick);
})`;

/** Intermediate moves for a drag: about one per `DRAG_STEP_PX`, within 5 to 50. */
export function dragSteps(from: Point, to: Point): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(Math.max(Math.round(distance / DRAG_STEP_PX), MIN_DRAG_STEPS), MAX_DRAG_STEPS);
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Refuse a point outside the viewport: it would hit nothing, or the wrong thing. */
export function assertInViewport(point: Point, viewport: ViewportSize): void {
  const inside =
    point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
  if (inside) return;
  throw new CommandError(
    "out_of_bounds",
    `Point (${fmt(point.x)}, ${fmt(point.y)}) is outside the viewport (${fmt(viewport.width)}x${fmt(viewport.height)} CSS pixels). Take a new browser_screenshot.`,
  );
}

/** The points an action touches: its point, and a drag's end. */
function pointsOf(command: MouseCommand): Point[] {
  const points = [{ x: command.x, y: command.y }];
  if (command.action === "drag") points.push({ x: command.toX ?? NaN, y: command.toY ?? NaN });
  return points;
}

/** Run `action` with `modifiers` held, releasing every key it pressed, also on failure. */
async function withModifiers(
  page: PointerPage,
  modifiers: BrowserModifierKey[],
  action: () => Promise<void>,
): Promise<void> {
  const held: BrowserModifierKey[] = [];
  try {
    for (const key of modifiers) {
      await page.keyboard.down(key);
      held.push(key);
    }
    await action();
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key).catch(() => undefined);
  }
}

async function drag(page: PointerPage, from: Point, to: Point, button: MouseCommand["button"]) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  try {
    await page.mouse.move(to.x, to.y, { steps: dragSteps(from, to) });
  } catch (error) {
    // Never leave a button held down on the page.
    await page.mouse.up({ button }).catch(() => undefined);
    throw error;
  }
  await page.mouse.up({ button });
}

/** Wait until a scroll has been rendered, bounded; a page that never answers is not an error. */
async function scrollSettled(page: PointerPage): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SCROLL_SETTLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([page.evaluate(SCROLL_SETTLED).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one pointer action on a page whose viewport is `viewport` (CSS pixels). */
export async function mouseAction(
  page: PointerPage,
  command: MouseCommand,
  viewport: ViewportSize,
): Promise<void> {
  const points = pointsOf(command);
  for (const point of points) assertInViewport(point, viewport);
  const [at, end] = points as [Point, Point | undefined];
  try {
    await withModifiers(page, command.modifiers ?? [], async () => {
      switch (command.action) {
        case "click":
          await page.mouse.click(at.x, at.y, {
            button: command.button,
            clickCount: command.clickCount ?? 1,
          });
          return;
        case "hover":
          await page.mouse.move(at.x, at.y);
          return;
        case "drag":
          await drag(page, at, end ?? at, command.button);
          return;
        case "scroll":
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(command.deltaX ?? 0, command.deltaY ?? 0);
          return;
      }
    });
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new CommandError(
      "action_failed",
      `Mouse ${command.action} at (${fmt(at.x)}, ${fmt(at.y)}) failed: ${message}`,
    );
  }
  if (command.action === "scroll") await scrollSettled(page);
}

/** `browser.mouse`: act at coordinates in a session's tab, checked against its current viewport. */
export async function mouse(
  session: BrowserSession,
  command: MouseCommand & { tabId?: string },
): Promise<void> {
  const page = session.page(command.tabId);
  await mouseAction(page, command, await session.currentViewport());
}
