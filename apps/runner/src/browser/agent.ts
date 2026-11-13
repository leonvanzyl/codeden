import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { MAX_FOCUS_TYPE_CHARS } from "@codeden/contracts";
import type { Locator, Page } from "playwright-core";
import { CommandError } from "../errors";
import { pngSize } from "./images";
import type { BrowserSession } from "./session";

/** Limits applied to `evaluate` (§12.2 agent tools). */
export interface EvaluateGuard {
  /** When false, `evaluate` is refused. Default true. */
  enabled: boolean;
  timeoutMs: number;
  /** The JSON result is cut to this many characters. */
  maxResultChars: number;
}

export const DEFAULT_EVALUATE_GUARD: EvaluateGuard = {
  enabled: true,
  timeoutMs: 5_000,
  maxResultChars: 20_000,
};

const MAX_SNAPSHOT_CHARS = 200_000;
const REF = /^(f\d+)?e\d+$/;

export interface SnapshotResult {
  tabId: string;
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
}

/**
 * Accessibility snapshot of a tab in YAML, with `[ref=eN]` element refs that stay stable
 * for unchanged elements across snapshots. Refs resolve against the latest snapshot.
 */
export async function snapshot(session: BrowserSession, tabId?: string): Promise<SnapshotResult> {
  const page = session.page(tabId);
  const text = await page.ariaSnapshot({ mode: "ai" });
  const truncated = text.length > MAX_SNAPSHOT_CHARS;
  return {
    tabId: session.tabId(tabId),
    url: page.url(),
    title: await page.title(),
    snapshot: truncated ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n# ... truncated` : text,
    truncated,
  };
}

/**
 * Run an action on the element behind a snapshot ref. Fails fast when the ref is not in the
 * latest snapshot instead of waiting for the action timeout.
 */
async function withRef<T>(
  page: Page,
  ref: string,
  action: (locator: Locator) => Promise<T>,
): Promise<T> {
  if (!REF.test(ref)) throw new CommandError("invalid_ref", `Not an element ref: ${ref}`);
  const locator = page.getByRef(ref);
  try {
    if ((await locator.count()) === 0) throw new Error("no such element");
    return await action(locator);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new CommandError(
      "action_failed",
      `Action on ${ref} failed: ${message}. Take a new snapshot if the page changed.`,
    );
  }
}

export async function click(
  session: BrowserSession,
  ref: string,
  opts: { tabId?: string; button?: "left" | "middle" | "right"; doubleClick?: boolean } = {},
): Promise<void> {
  const options = opts.button ? { button: opts.button } : {};
  await withRef(session.page(opts.tabId), ref, (locator) =>
    opts.doubleClick ? locator.dblclick(options) : locator.click(options),
  );
}

/**
 * Replace the value of an editable element; `submit` presses Enter afterwards. Without a ref,
 * type the text as key presses into whatever has focus (a canvas editor, a game, a field
 * clicked at coordinates).
 */
export async function type(
  session: BrowserSession,
  ref: string | undefined,
  text: string,
  opts: { tabId?: string; submit?: boolean } = {},
): Promise<void> {
  const page = session.page(opts.tabId);
  if (ref === undefined) {
    if (text.length > MAX_FOCUS_TYPE_CHARS) {
      throw new CommandError(
        "invalid_text",
        `Without a ref, type at most ${MAX_FOCUS_TYPE_CHARS} characters`,
      );
    }
    try {
      await page.keyboard.type(text);
      if (opts.submit) await page.keyboard.press("Enter");
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new CommandError("action_failed", `Typing at the focused element failed: ${message}`);
    }
    return;
  }
  await withRef(page, ref, async (locator) => {
    await locator.fill(text);
    if (opts.submit) await locator.press("Enter");
  });
}

/** Press a key or chord (`Enter`, `Control+A`) on whatever has focus. */
export async function press(session: BrowserSession, key: string, tabId?: string): Promise<void> {
  try {
    await session.page(tabId).keyboard.press(key);
  } catch (error) {
    throw new CommandError("action_failed", `Could not press ${key}: ${String(error)}`);
  }
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * PNG of the viewport, the full page, or one element (`ref`), written to an absolute path.
 * The viewport is whatever the panel sized it to; images are in CSS pixels (`scale: "css"`),
 * so a HiDPI viewer doesn't double what the agent gets back.
 */
export async function screenshot(
  session: BrowserSession,
  path: string,
  opts: { tabId?: string; fullPage?: boolean; ref?: string } = {},
): Promise<ScreenshotResult> {
  if (!isAbsolute(path)) throw new CommandError("invalid_path", "Screenshot path must be absolute");
  if (extname(path).toLowerCase() !== ".png") {
    throw new CommandError("invalid_path", "Screenshot path must end in .png");
  }
  const page = session.page(opts.tabId);
  const ref = opts.ref;
  const buffer = ref
    ? await withRef(page, ref, (locator) => locator.screenshot({ type: "png", scale: "css" }))
    : await page.screenshot({ type: "png", scale: "css", fullPage: opts.fullPage ?? false });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  const size = pngSize(buffer);
  if (!size) throw new CommandError("action_failed", "Screenshot is not a valid PNG");
  return { path, ...size, bytes: buffer.length };
}

/**
 * Evaluate a JS expression (or function source, which is called) in the tab's page.
 * Guarded: can be disabled, times out, and the JSON result is size-capped.
 */
export async function evaluate(
  session: BrowserSession,
  expression: string,
  guard: EvaluateGuard,
  tabId?: string,
): Promise<{ json: string; truncated: boolean }> {
  if (!guard.enabled) throw new CommandError("forbidden", "evaluate is disabled for this runner");
  const page = session.page(tabId);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CommandError("timeout", `evaluate timed out after ${guard.timeoutMs}ms`)),
      guard.timeoutMs,
    );
  });
  try {
    const value: unknown = await Promise.race([evaluateValue(page, expression), timeout]);
    const json = JSON.stringify(value === undefined ? null : value) ?? "null";
    const truncated = json.length > guard.maxResultChars;
    return { json: truncated ? json.slice(0, guard.maxResultChars) : json, truncated };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new CommandError("evaluate_failed", message ?? "evaluate failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Evaluate an expression; when it yields a function (`() => ...`), call it. CSP-safe. */
async function evaluateValue(page: Page, expression: string): Promise<unknown> {
  const handle = await page.evaluateHandle(expression);
  try {
    return await handle.evaluate((v: unknown) => (typeof v === "function" ? v() : v));
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

export interface WaitOptions {
  tabId?: string;
  selector?: string;
  text?: string;
  networkIdle?: boolean;
  timeoutMs?: number;
}

/** Wait for exactly one condition; resolves `false` on timeout instead of throwing. */
export async function wait(session: BrowserSession, opts: WaitOptions): Promise<boolean> {
  const conditions = [opts.selector, opts.text, opts.networkIdle ? true : undefined];
  if (conditions.filter((c) => c !== undefined).length !== 1) {
    throw new CommandError("invalid_wait", "Give exactly one of selector, text or networkIdle");
  }
  const page = session.page(opts.tabId);
  const timeout = opts.timeoutMs ?? session.timeoutMs;
  try {
    if (opts.selector) await page.locator(opts.selector).first().waitFor({ timeout });
    else if (opts.text) await page.getByText(opts.text).first().waitFor({ timeout });
    else await page.waitForLoadState("networkidle", { timeout });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return false;
    throw new CommandError("action_failed", error instanceof Error ? error.message : String(error));
  }
}
