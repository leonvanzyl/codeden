import { cssToSrgb, srgbToHex } from "@/lib/oklch";
import type { ResolvedTheme } from "./resolve";

/** The colours xterm.js takes (the part of its `ITheme` CodeDen sets). */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  brightBlack?: string;
  green: string;
  cyan: string;
  yellow: string;
  red: string;
  blue: string;
  magenta: string;
  white: string;
}

/** The terminal's colours with CodeDen's own themes, unchanged. */
const CODEDEN: Record<"dark" | "light", TerminalColors> = {
  dark: {
    background: "#14161b",
    foreground: "#d9dce3",
    cursor: "#f2b34b",
    selectionBackground: "#f2b34b40",
    black: "#1c1f26",
    green: "#7fd19b",
    cyan: "#7cc7e8",
    yellow: "#f2c66d",
    red: "#f28b82",
    blue: "#8ab4f8",
    magenta: "#c79bf2",
    white: "#d9dce3",
  },
  light: {
    background: "#fbfbfc",
    foreground: "#2a2e37",
    cursor: "#b4670e",
    selectionBackground: "#b4670e30",
    black: "#2a2e37",
    green: "#1f8a4c",
    cyan: "#1b7a9e",
    yellow: "#9a6a00",
    red: "#c2382f",
    blue: "#2b5fd9",
    magenta: "#8a3fc7",
    white: "#6b7280",
  },
};

const hex = (css: string, fallback: string) => {
  const rgb = cssToSrgb(css);
  return rgb ? srgbToHex(rgb) : fallback;
};

/**
 * The terminal's colours for a theme. Other themes paint it on their workbench panel with their
 * own text, accent and status colours, so every ANSI colour has the contrast the theme's status
 * colours have; bright black (dimmed text in most shells) is the theme's muted text.
 */
export function terminalColors(theme: ResolvedTheme): TerminalColors {
  const own = CODEDEN[theme.kind];
  if (theme.builtIn) return own;
  const t = theme.tokens;
  const primary = hex(t.primary, own.cursor);
  return {
    background: hex(t.panel, own.background),
    foreground: hex(t.foreground, own.foreground),
    cursor: primary,
    selectionBackground: `${primary}40`,
    black: hex(t.muted, own.black),
    brightBlack: hex(t["muted-foreground"], own.white),
    green: hex(t["status-done"], own.green),
    cyan: hex(t["chart-2"], own.cyan),
    yellow: hex(t["status-waiting"], own.yellow),
    red: hex(t["status-failed"], own.red),
    blue: hex(t["status-running"], own.blue),
    magenta: hex(t["chart-4"], own.magenta),
    white: hex(t["secondary-foreground"], own.white),
  };
}
