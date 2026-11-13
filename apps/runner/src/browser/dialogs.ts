import { randomBytes } from "node:crypto";
import {
  type BrowserDialog,
  type BrowserDialogClosed,
  type BrowserDialogCloser,
  type BrowserDialogType,
  DIALOG_TIMEOUT_MS,
  MAX_DIALOG_TEXT,
} from "@codeden/contracts";
import type { CDPSession } from "playwright-core";
import { CommandError } from "../errors";

/** What the keeper uses of a Playwright `Dialog` (a fake one in unit tests). */
export interface PageDialog {
  type(): string;
  message(): string;
  defaultValue(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface DialogKeeperOptions {
  /** The open dialogs changed: one opened, or `closed` just closed. */
  onChange(dialogs: BrowserDialog[], closed?: BrowserDialogClosed): void;
  /** Unanswered dialogs are dismissed after this long. Default `DIALOG_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface Held {
  info: BrowserDialog;
  dialog: PageDialog;
  timer: NodeJS.Timeout;
}

const TYPES: readonly string[] = ["alert", "confirm", "prompt", "beforeunload"];

const cut = (text: string) =>
  text.length > MAX_DIALOG_TEXT ? text.slice(0, MAX_DIALOG_TEXT) : text;

/** `confirm "Delete this item?"`, for messages to agents. */
export function describeDialog(dialog: BrowserDialog): string {
  const kind = dialog.type === "beforeunload" ? "Leave page? (beforeunload)" : dialog.type;
  return dialog.message ? `${kind} "${dialog.message}"` : kind;
}

/**
 * A session's page dialogs (§12.2): `alert`, `confirm`, `prompt` and `beforeunload`. Left alone,
 * Playwright dismisses each one the moment it opens, so a confirm returns false before anybody
 * sees it. The keeper holds each dialog open instead (the page waits) until a viewer or an agent
 * answers it, the browser closes it, or the timeout dismisses it, and reports every change. A
 * tab shows at most one dialog at a time.
 */
export class DialogKeeper {
  private readonly held = new Map<string, Held>();
  /** Tabs CodeDen is navigating itself (agent or toolbar): their "Leave site?" is accepted. */
  private readonly navigating = new Map<string, number>();
  private readonly waiters = new Map<string, Set<(dialog: BrowserDialog) => void>>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: DialogKeeperOptions) {
    this.timeoutMs = opts.timeoutMs ?? DIALOG_TIMEOUT_MS;
  }

  /** A dialog opened on `tabId`: hold it until it is answered. */
  opened(tabId: string, dialog: PageDialog): void {
    const raw = dialog.type();
    const type = (TYPES.includes(raw) ? raw : "alert") as BrowserDialogType;
    if (type === "beforeunload" && (this.navigating.get(tabId) ?? 0) > 0) {
      // CodeDen asked for this navigation: it must not wait on a "Leave site?".
      void dialog.accept().catch(() => undefined);
      return;
    }
    // A tab shows one dialog at a time: one still held here was closed without word.
    this.forget(tabId);
    const info: BrowserDialog = {
      // Random, so an answer meant for an earlier dialog (even of a browser since reopened)
      // never matches this one.
      dialogId: `d${randomBytes(4).toString("hex")}`,
      tabId,
      type,
      message: cut(dialog.message()),
      ...(type === "prompt" ? { defaultValue: cut(dialog.defaultValue()) } : {}),
    };
    const timer = setTimeout(() => void this.close(tabId, "timeout", false), this.timeoutMs);
    timer.unref?.();
    this.held.set(tabId, { info, dialog, timer });
    this.opts.onChange(this.list());
    for (const wake of this.waiters.get(tabId) ?? []) wake(info);
  }

  /** The dialog open on `tabId`, if any. */
  get(tabId: string): BrowserDialog | undefined {
    return this.held.get(tabId)?.info;
  }

  /** Every open dialog. */
  list(): BrowserDialog[] {
    return [...this.held.values()].map((h) => h.info);
  }

  /** Refuse to act on a tab whose page is paused under a dialog. */
  assertNone(tabId: string): void {
    const dialog = this.get(tabId);
    if (!dialog) return;
    throw new CommandError(
      "dialog_open",
      `A ${describeDialog(dialog)} dialog is open on tab ${tabId}, and the page waits until it is answered. Answer it with browser_dialog (dialogId "${dialog.dialogId}"; accept: true for OK, false for Cancel) first.`,
    );
  }

  /**
   * Answer dialog `dialogId`: `accept` is OK, otherwise Cancel. An accepted prompt returns
   * `promptText`, or its default text. Throws `no_dialog` when that dialog is no longer open:
   * an answer meant for it must never reach the dialog the page opened next.
   */
  async answer(
    dialogId: string,
    answer: { accept: boolean; promptText?: string; by: "agent" | "viewer" },
  ): Promise<BrowserDialog> {
    const held = [...this.held.values()].find((h) => h.info.dialogId === dialogId);
    if (!held) {
      throw new CommandError(
        "no_dialog",
        `Dialog ${dialogId} is no longer open: it was answered, timed out or closed. Take a new browser_snapshot to see the page now.`,
      );
    }
    await this.close(held.info.tabId, answer.by, answer.accept, answer.promptText);
    return held.info;
  }

  /**
   * The dialog on `tabId` closed without an answer from here: the tab closed or navigated, or
   * it was answered in the desktop app's own dialog box.
   */
  closedElsewhere(tabId: string, accepted = false): void {
    const held = this.forget(tabId);
    if (held) this.opts.onChange(this.list(), { ...held.info, by: "browser", accepted });
  }

  /** Follow dialogs that close without the keeper on a tab, through the tab's CDP session. */
  async watchClosing(tabId: string, cdp: Promise<CDPSession>): Promise<void> {
    try {
      const session = await cdp;
      session.on("Page.javascriptDialogClosed", (event) => {
        this.closedElsewhere(tabId, event.result);
      });
      await session.send("Page.enable");
    } catch {
      // The tab closed under us.
    }
  }

  /**
   * Run an action on `tabId` and settle as soon as it opens a dialog there: the page, and with
   * it the action, then waits for an answer (the action finishes on its own afterwards).
   */
  async race(tabId: string, action: () => Promise<unknown>): Promise<{ dialog?: BrowserDialog }> {
    let wake: (dialog: BrowserDialog) => void = () => undefined;
    const opened = new Promise<BrowserDialog>((resolve) => {
      wake = resolve;
    });
    const waiting = this.waiters.get(tabId) ?? new Set();
    waiting.add(wake);
    this.waiters.set(tabId, waiting);
    const running = action();
    try {
      return await Promise.race([running.then(() => ({})), opened.then((dialog) => ({ dialog }))]);
    } finally {
      waiting.delete(wake);
      if (waiting.size === 0) this.waiters.delete(tabId);
      // Settles once the dialog is answered; nobody waits for it any more.
      running.catch(() => undefined);
    }
  }

  /** Run a navigation CodeDen started on `tabId`: a "Leave site?" it raises is accepted. */
  async whileNavigating<T>(tabId: string, navigation: () => Promise<T>): Promise<T> {
    this.navigating.set(tabId, (this.navigating.get(tabId) ?? 0) + 1);
    try {
      return await navigation();
    } finally {
      const left = (this.navigating.get(tabId) ?? 1) - 1;
      if (left > 0) this.navigating.set(tabId, left);
      else this.navigating.delete(tabId);
    }
  }

  /** Stop the timers (the browser is closing; its dialogs go with it). */
  dispose(): void {
    for (const tabId of [...this.held.keys()]) this.forget(tabId);
  }

  private forget(tabId: string): Held | undefined {
    const held = this.held.get(tabId);
    if (!held) return undefined;
    clearTimeout(held.timer);
    this.held.delete(tabId);
    return held;
  }

  private async close(
    tabId: string,
    by: BrowserDialogCloser,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    const held = this.forget(tabId);
    if (!held) return;
    this.opts.onChange(this.list(), { ...held.info, by, accepted: accept });
    try {
      if (!accept) await held.dialog.dismiss();
      else if (held.info.type === "prompt") {
        await held.dialog.accept(promptText ?? held.info.defaultValue ?? "");
      } else await held.dialog.accept();
    } catch {
      // Gone already: the tab closed or navigated under it.
    }
  }
}
