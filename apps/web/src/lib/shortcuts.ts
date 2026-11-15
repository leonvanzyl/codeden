/** Keyboard shortcuts: one registry for binding, the help dialog and Settings. */

export type ShortcutId =
  | "palette"
  | "sidebar"
  | "rightPanel"
  | "terminal"
  | "inbox"
  | "orchestrator"
  | "settings"
  | "theme"
  | "help"
  | "send"
  | "newline"
  | "stop"
  | "dictate"
  | "focusComposer"
  | "modelPicker"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6";

export interface Shortcut {
  id: ShortcutId;
  combo: string;
  label: string;
  group: "General" | "Navigation" | "Composer" | "Panels";
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", combo: "mod+k", label: "Command palette", group: "General" },
  { id: "help", combo: "shift+?", label: "Keyboard shortcuts", group: "General" },
  { id: "theme", combo: "mod+shift+l", label: "Toggle light / dark", group: "General" },
  { id: "settings", combo: "mod+,", label: "Settings", group: "General" },
  { id: "orchestrator", combo: "alt+o", label: "Go to orchestrator", group: "Navigation" },
  { id: "inbox", combo: "alt+i", label: "Go to inbox", group: "Navigation" },
  { id: "sidebar", combo: "mod+b", label: "Toggle sidebar", group: "Panels" },
  { id: "rightPanel", combo: "mod+\\", label: "Toggle right panel", group: "Panels" },
  { id: "terminal", combo: "mod+j", label: "Toggle terminal drawer", group: "Panels" },
  { id: "tab1", combo: "alt+1", label: "Diff tab", group: "Panels" },
  { id: "tab2", combo: "alt+2", label: "Files tab", group: "Panels" },
  { id: "tab3", combo: "alt+3", label: "Browser tab", group: "Panels" },
  { id: "tab4", combo: "alt+4", label: "Terminal tab", group: "Panels" },
  { id: "tab5", combo: "alt+5", label: "Issue / PR tab", group: "Panels" },
  { id: "tab6", combo: "alt+6", label: "Details tab", group: "Panels" },
  { id: "focusComposer", combo: "/", label: "Focus the composer", group: "Composer" },
  { id: "send", combo: "enter", label: "Send (queue while running)", group: "Composer" },
  { id: "newline", combo: "shift+enter", label: "New line", group: "Composer" },
  { id: "stop", combo: "mod+.", label: "Stop the running turn", group: "Composer" },
  { id: "dictate", combo: "mod+shift+m", label: "Start / stop dictation", group: "Composer" },
  { id: "modelPicker", combo: "alt+m", label: "Choose model and effort", group: "Composer" },
];

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Human label for a combo, e.g. `Ctrl Shift L` or `⌘ ⇧ L`. */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      if (part === "shift") return isMac ? "⇧" : "Shift";
      if (part === "alt") return isMac ? "⌥" : "Alt";
      if (part === "enter") return "Enter";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(" ");
}

/** Does a keyboard event match a combo like `mod+shift+l`? */
export function matchesCombo(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code">,
  combo: string,
): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const mod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (mod !== modPressed) return false;
  if (wantAlt !== e.altKey) return false;
  // `?` implies shift on most layouts; don't require an exact shift match for symbols.
  if (key.length === 1 && !/[a-z0-9]/.test(key)) {
    return e.key === key || (key === "\\" && e.code === "Backslash");
  }
  if (wantShift !== e.shiftKey) return false;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.key === key;
  // Combos name the space bar `space` (as recorded in Settings); its key is " ".
  return (e.key === " " ? "space" : e.key.toLowerCase()) === key;
}

export function shortcut(id: ShortcutId): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  return s;
}

/**
 * Whether a combo leaves typing alone: it holds Ctrl/⌘ or Alt, or is a function key (F1–F24).
 * Shift alone doesn't count (Shift+A types "A"); a combo like `space`, `a` or `enter` would take
 * that key over in every text field.
 */
export function leavesTypingAlone(combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  if (parts.includes("mod") || parts.includes("alt")) return true;
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(parts.at(-1) ?? "");
}

/** True when focus is in a text field, where single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
    Boolean(el.closest?.(".cm-editor, .xterm"))
  );
}
