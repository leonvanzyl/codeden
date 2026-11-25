import type { Rgb } from "@/lib/oklch";
import { composite, contrast } from "./color";
import type { ThemeTokens, ThemeVariable } from "./tokens";

/** WCAG 2.2 AA minimums: 1.4.3 for text, 1.4.11 for control outlines, focus and indicators. */
export const TEXT_MIN = 4.5;
export const UI_MIN = 3;

/** One colour pair a theme must keep readable. */
interface Pair {
  label: string;
  fg: ThemeVariable;
  bg: ThemeVariable;
  min: number;
}

const SURFACES: ThemeVariable[] = [
  "background",
  "card",
  "popover",
  "muted",
  "secondary",
  "accent",
  "message",
  "surface",
  "panel",
];

const text = (fg: ThemeVariable, bg: ThemeVariable, label: string): Pair => ({
  label,
  fg,
  bg,
  min: TEXT_MIN,
});
const ui = (fg: ThemeVariable, bg: ThemeVariable, label: string): Pair => ({
  label,
  fg,
  bg,
  min: UI_MIN,
});

/**
 * The pairs CodeDen draws: text on each surface it sits on, accent and status colours used as
 * text, and the outlines, focus ring and status dots (3:1). Dividers (`border`) only separate
 * areas, so WCAG sets them no minimum; input outlines (`input`) carry that job.
 */
export const CONTRAST_PAIRS: Pair[] = [
  ...SURFACES.map((bg) => text("foreground", bg, `Text on ${bg}`)),
  ...["background", "card", "popover", "muted", "message", "panel"].map((bg) =>
    text("muted-foreground", bg as ThemeVariable, `Muted text on ${bg}`),
  ),
  text("muted-foreground", "sidebar", "Muted text on sidebar"),
  text("secondary-foreground", "secondary", "Secondary button text"),
  text("accent-foreground", "accent", "Hovered item text"),
  text("sidebar-foreground", "sidebar", "Sidebar text"),
  text("sidebar-foreground", "sidebar-accent", "Sidebar text on hover"),
  text("sidebar-accent-foreground", "sidebar-accent", "Selected sidebar item"),
  text("primary-foreground", "primary", "Primary button text"),
  text("sidebar-primary-foreground", "sidebar-primary", "Sidebar primary text"),
  text("primary", "background", "Accent text (links)"),
  text("primary", "card", "Accent text on cards"),
  text("destructive", "background", "Destructive text"),
  ...(["status-running", "status-waiting", "status-done", "status-failed"] as const).flatMap(
    (s) => [
      text(s, "background", `${s.slice(7)} status text`),
      text(s, "card", `${s.slice(7)} status on cards`),
    ],
  ),
  text("diff-add", "background", "Added-lines count"),
  text("diff-del", "background", "Removed-lines count"),
  ui("input", "background", "Input outline"),
  ui("input", "card", "Input outline on cards"),
  ui("ring", "background", "Focus ring"),
  ui("status-idle", "sidebar", "Idle status dot"),
  ui("status-idle", "background", "Idle status dot on page"),
];

export interface ContrastResult extends Pair {
  ratio: number;
  pass: boolean;
}

/**
 * Measures every pair in `CONTRAST_PAIRS`. Translucent colours are painted over the surface
 * below them (the background for surfaces themselves), as the browser does.
 */
export function auditContrast(tokens: ThemeTokens): ContrastResult[] {
  const page = composite(tokens.background, [0, 0, 0]) ?? ([0, 0, 0] as Rgb);
  return CONTRAST_PAIRS.map((pair) => {
    const bg = composite(tokens[pair.bg], page) ?? page;
    const fg = composite(tokens[pair.fg], bg) ?? bg;
    const ratio = contrast(fg, bg);
    // Rounded down to two places, as checkers report it: 4.499 is not 4.5.
    const shown = Math.floor(ratio * 100) / 100;
    return { ...pair, ratio: shown, pass: shown >= pair.min };
  });
}
