import { type BrowserDialog, type BrowserTab, DIALOG_TIMEOUT_MS } from "@codeden/contracts";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const minutes = Math.round(DIALOG_TIMEOUT_MS / 60_000);

/** `localhost:5173`, the way browsers name who is asking. */
function origin(url: string | undefined): string {
  try {
    return url ? new URL(url).host || url : "This page";
  } catch {
    return url ?? "This page";
  }
}

/** The dialog the panel shows: the active tab's, else any tab's. */
export function shownDialog(
  dialogs: readonly BrowserDialog[],
  activeTabId: string | undefined,
): BrowserDialog | undefined {
  return dialogs.find((d) => d.tabId === activeTabId) ?? dialogs[0];
}

/**
 * The page dialog over the browser panel's page, if any (see `PageDialog`). The card is keyed by
 * its dialog's id: dialogs opening or closing on other tabs never remount it (a prompt keeps what
 * was typed), and a new dialog always gets a fresh card.
 */
export function PageDialogLayer({
  dialogs,
  tabs,
  activeTabId,
  onAnswer,
}: {
  dialogs: readonly BrowserDialog[];
  tabs: readonly BrowserTab[];
  activeTabId: string | undefined;
  /** Send the answer for `dialogId`; false when it could not be sent (disconnected). */
  onAnswer(dialogId: string, accept: boolean, promptText?: string): boolean;
}) {
  const dialog = shownDialog(dialogs, activeTabId);
  if (!dialog) return null;
  return (
    <PageDialog
      key={dialog.dialogId}
      dialog={dialog}
      tab={tabs.find((t) => t.tabId === dialog.tabId)}
      active={dialog.tabId === activeTabId}
      onAnswer={(accept, text) => onAnswer(dialog.dialogId, accept, text)}
    />
  );
}

/**
 * The page's own `alert`, `confirm`, `prompt` or "Leave this page?" (§12.2), over the page it
 * paused. OK, Cancel and the prompt's field work with mouse, touch and keyboard (Enter answers,
 * Escape cancels). It only takes focus when the browser panel already had it, so a dialog the
 * agent opens never catches keys meant for the chat. Answered once: the buttons wait for the
 * next dialog (unless the answer could not be sent).
 */
export function PageDialog({
  dialog,
  tab,
  active,
  onAnswer,
}: {
  dialog: BrowserDialog;
  /** The tab that shows it. */
  tab: BrowserTab | undefined;
  /** It is on the tab the panel shows (otherwise the card names the tab). */
  active: boolean;
  /** False when the answer could not be sent (the card stays answerable). */
  onAnswer(accept: boolean, promptText?: string): boolean;
}) {
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(dialog.defaultValue ?? "");
  const [sent, setSent] = useState(false);
  const leave = dialog.type === "beforeunload";

  useEffect(() => {
    const panel = box.current?.closest("[data-testid=browser-panel]");
    const focused = document.activeElement;
    if (focused && focused !== document.body && !panel?.contains(focused)) return;
    if (field.current) field.current.select();
    else ok.current?.focus();
  }, []);

  const answer = (accept: boolean) => {
    if (sent) return;
    if (onAnswer(accept, accept && dialog.type === "prompt" ? text : undefined)) setSent(true);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    answer(false);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    answer(true);
  };

  return (
    <div
      ref={box}
      data-testid="browser-page-dialog"
      className="absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[10%]"
    >
      <form
        role="alertdialog"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-message`}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      >
        <h2 id={`${ids}-title`} className="text-sm font-medium">
          {leave ? "Leave this page?" : `${origin(tab?.url)} says`}
        </h2>
        {!active && tab && (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">
            In tab “{tab.title || tab.url}”
          </p>
        )}
        <p
          id={`${ids}-message`}
          className="mt-2 max-h-48 overflow-y-auto text-sm break-words whitespace-pre-wrap"
        >
          {leave ? dialog.message || "Changes you made may not be saved." : dialog.message}
        </p>
        {dialog.type === "prompt" && (
          <Input
            ref={field}
            aria-label="Your answer"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-3"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <Button type="button" variant="outline" disabled={sent} onClick={() => answer(false)}>
              {leave ? "Stay" : "Cancel"}
            </Button>
          )}
          <Button type="submit" disabled={sent} ref={ok}>
            {leave ? "Leave" : "OK"}
          </Button>
        </div>
        <p className="mt-3 text-2xs text-muted-foreground">
          The page waits for an answer from you or the agent. Unanswered, it is dismissed after{" "}
          {minutes} minutes.
        </p>
      </form>
    </div>
  );
}
