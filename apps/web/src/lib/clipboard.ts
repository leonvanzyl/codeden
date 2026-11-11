/**
 * Copying text that works everywhere the UI runs. The async Clipboard API exists only in
 * secure contexts (https, localhost), so a phone or tablet that reaches CodeDen over the local
 * network on plain http has no `navigator.clipboard` at all. There the text is copied the
 * older way: select it in a hidden textarea and run the browser's copy command.
 *
 * Call these synchronously from the tap or click handler (before any `await`), so the copy
 * still counts as part of the user's gesture.
 */

/** What `copyText` needs from the browser; injectable so the branch choice can be tested. */
export interface ClipboardEnv {
  isSecureContext: boolean;
  clipboard: { writeText(text: string): Promise<void> } | undefined;
  /** The textarea + copy-command fallback; true when the browser reports success. */
  fallback(text: string): boolean;
}

function browserEnv(): ClipboardEnv {
  return {
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    fallback: execCommandCopy,
  };
}

/**
 * Copies `text`; resolves true when it reached the clipboard and false when every way failed.
 * Never rejects.
 */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.isSecureContext && env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Denied (permissions policy, unfocused document): the copy command may still work.
    }
  }
  try {
    return env.fallback(text);
  } catch {
    return false;
  }
}

/**
 * Copies with a hidden, read-only textarea and `document.execCommand("copy")`. Works on
 * insecure origins in Android Chrome and iOS Safari. Focus and the page's selection are
 * restored afterwards.
 */
export function execCommandCopy(text: string, doc: Document = document): boolean {
  if (!doc.body) return false;
  const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const selection = doc.getSelection();
  const ranges: Range[] = [];
  for (let i = 0; i < (selection?.rangeCount ?? 0); i++) {
    const range = selection?.getRangeAt(i);
    if (range) ranges.push(range);
  }

  const area = doc.createElement("textarea");
  area.value = text;
  // Read-only keeps the on-screen keyboard closed on phones.
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  const scrollTop = doc.defaultView?.scrollY ?? 0;
  Object.assign(area.style, {
    position: "absolute",
    left: "-9999px",
    top: `${scrollTop}px`,
    // At 16px or more, iOS doesn't zoom in when the field is focused.
    fontSize: "16px",
    border: "0",
    padding: "0",
    margin: "0",
    whiteSpace: "pre",
  });
  // Inside a dialog or menu, focus has to stay in it: their focus traps would pull it back.
  const host =
    active?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]') ??
    doc.body;
  host.appendChild(area);

  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    area.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    active?.focus({ preventScroll: true });
  }
  return ok;
}

/**
 * Gives insecure origins a `navigator.clipboard.writeText` backed by the copy-command
 * fallback, so copy buttons in third-party components (the code blocks in rendered
 * markdown) work there too. `onFail` runs when a copy didn't reach the clipboard.
 * Does nothing where the real API exists.
 */
export function installClipboardFallback(onFail: () => void): void {
  if (typeof navigator === "undefined" || navigator.clipboard) return;
  const writeText = async (text: string) => {
    if (execCommandCopy(text)) return;
    onFail();
    throw new Error("Copy failed");
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}
