import type { ThemeTokenKey, ThemeTokenOverrides } from "@codeden/contracts";
import { cssToSrgb, type Rgb, srgbToHex } from "@/lib/oklch";
import { composite, contrast, formatOklch, toOklch, withContrast } from "./color";
import type { ThemeKind } from "./presets";
import { KEY_VARIABLE, type ThemeTokens, type ThemeVariable } from "./tokens";

/** Surfaces that keep their lightness step from the page when the background changes. */
const SURFACES: ThemeVariable[] = [
  "card",
  "popover",
  "secondary",
  "muted",
  "accent",
  "sidebar",
  "sidebar-accent",
  "panel",
  "message",
  "surface",
];

/** Text that is the body text colour exactly. */
const TEXT_SAME: ThemeVariable[] = [
  "card-foreground",
  "popover-foreground",
  "accent-foreground",
  "sidebar-accent-foreground",
];
/** Text a step off the body text (kept at the base theme's offset). */
const TEXT_STEP: ThemeVariable[] = ["secondary-foreground", "sidebar-foreground"];

/** Variables that follow a status key. */
const STATUS_FOLLOWERS: Partial<Record<ThemeTokenKey, ThemeVariable[]>> = {
  running: ["chart-2"],
  done: ["diff-add", "chart-3"],
  failed: ["destructive", "diff-del", "chart-5"],
};

/** `value` with `from`'s lightness/chroma offset from `fromBase`, kept relative to `to`. */
function stepFrom(value: string, fromBase: string, to: string): string {
  const v = toOklch(value);
  const b = toOklch(fromBase);
  const t = toOklch(to);
  if (!v || !b || !t) return value;
  const hue = t.c < 0.005 ? v.h : t.h;
  return formatOklch(t.l + (v.l - b.l), Math.max(0, t.c + (v.c - b.c)), hue, v.alpha);
}

/** `color` at `alphaOf`'s opacity. */
function withAlphaOf(color: string, alphaOf: string): string {
  const c = toOklch(color);
  const a = toOklch(alphaOf);
  return c ? formatOklch(c.l, c.c, c.h, a?.alpha ?? 1) : color;
}

/**
 * Text for a button in `color`: a dark ink tinted with its hue or white, whichever reads better;
 * pure black when a mid-tone accent leaves the tinted ink under 4.5:1.
 */
function inkOn(color: string): string {
  const rgb = cssToSrgb(color);
  const o = toOklch(color);
  if (!rgb || !o) return "oklch(1 0 0)";
  const ink = formatOklch(0.2, 0.04, o.h);
  const onInk = contrast(rgb, cssToSrgb(ink) as Rgb);
  const onWhite = contrast(rgb, [1, 1, 1]);
  if (onWhite > onInk) return "oklch(1 0 0)";
  return onInk >= 4.5 ? ink : "oklch(0 0 0)";
}

/**
 * A custom theme's full set of colours: the base preset's, with each overridden key set and the
 * colours that depend on it brought along (surfaces follow the background, button text is
 * picked for the accent, input outlines are kept at 3:1, diffs follow done and failed).
 * Colours that depend on nothing overridden stay exactly as the preset has them.
 */
export function customTokens(
  base: ThemeTokens,
  kind: ThemeKind,
  overrides: ThemeTokenOverrides,
): ThemeTokens {
  const t: ThemeTokens = { ...base };
  const o = overrides;
  if (o.background) {
    for (const v of SURFACES) t[v] = stepFrom(base[v], base.background, o.background);
    t.background = o.background;
  }
  if (o.foreground) {
    t.foreground = o.foreground;
    for (const v of TEXT_SAME) t[v] = o.foreground;
    for (const v of TEXT_STEP) t[v] = stepFrom(base[v], base.foreground, o.foreground);
  }
  if (o.mutedText) t["muted-foreground"] = o.mutedText;
  if (o.primary) {
    const ink = inkOn(o.primary);
    t.primary = o.primary;
    t["sidebar-primary"] = o.primary;
    t["chart-1"] = o.primary;
    t["primary-foreground"] = ink;
    t["sidebar-primary-foreground"] = ink;
    t.ring = withAlphaOf(o.primary, base.ring);
    t["sidebar-ring"] = withAlphaOf(o.primary, base["sidebar-ring"]);
    t.glow = withAlphaOf(o.primary, base.glow);
  }
  if (o.border) {
    t.border = o.border;
    t["sidebar-border"] = o.border;
    const page = cssToSrgb(t.background) ?? [0, 0, 0];
    t.input = withContrast(o.border, page, 3, kind === "dark" ? "lighter" : "darker");
  }
  for (const key of ["running", "waiting", "done", "failed"] as const) {
    const value = o[key];
    if (!value) continue;
    t[KEY_VARIABLE[key]] = value;
    for (const v of STATUS_FOLLOWERS[key] ?? []) t[v] = value;
  }
  return t;
}

/** A key's current colour as `#rrggbb`, translucent ones as seen on the page. */
export function keyColor(tokens: ThemeTokens, key: ThemeTokenKey): string {
  const page = cssToSrgb(tokens.background) ?? [0, 0, 0];
  const rgb = composite(tokens[KEY_VARIABLE[key]], page) ?? page;
  return srgbToHex(rgb);
}
