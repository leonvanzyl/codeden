/**
 * Colour helpers for themes: reading token values, WCAG contrast and small OKLCH adjustments.
 * Pure, so the contrast checks run in tests exactly as in the theme editor.
 */
import { cssToSrgb, parseOklch, type Rgb, srgbToHex, srgbToOklch } from "@/lib/oklch";

/** A token value as sRGB plus opacity; null when it isn't `#hex` or `oklch()`. */
export function readColor(css: string): { rgb: Rgb; alpha: number } | null {
  const rgb = cssToSrgb(css);
  if (!rgb) return null;
  return { rgb, alpha: parseOklch(css)?.alpha ?? 1 };
}

/** `css` painted over the opaque `below`: what the eye sees for translucent tokens. */
export function composite(css: string, below: Rgb): Rgb | null {
  const c = readColor(css);
  if (!c) return null;
  const a = c.alpha;
  return c.rgb.map((v, i) => v * a + (below[i] as number) * (1 - a)) as Rgb;
}

/** WCAG 2.2 relative luminance of a gamma-encoded sRGB colour. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.2 contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A token value as `#rrggbb` (opacity dropped), for colour inputs; null when unreadable. */
export function toHex(css: string): string | null {
  const c = readColor(css);
  return c ? srgbToHex(c.rgb) : null;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** An `oklch()` string, rounded like the hand-written tokens. */
export function formatOklch(l: number, c: number, h: number, alpha = 1): string {
  const body = `${round(Math.min(1, Math.max(0, l)), 3)} ${round(Math.max(0, c), 3)} ${round(h, 1)}`;
  return alpha < 1 ? `oklch(${body} / ${round(alpha * 100, 1)}%)` : `oklch(${body})`;
}

/** A token value in OKLCH; null when unreadable. */
export function toOklch(css: string): { l: number; c: number; h: number; alpha: number } | null {
  const parsed = parseOklch(css);
  if (parsed) return parsed;
  const c = readColor(css);
  return c ? { ...srgbToOklch(c.rgb), alpha: c.alpha } : null;
}

/**
 * Moves `css` toward `toward` in OKLCH lightness, in small steps, until it reaches `ratio`
 * against `against` (or can't go further). Used for derived outlines and accent text.
 */
export function withContrast(
  css: string,
  against: Rgb,
  ratio: number,
  toward: "lighter" | "darker",
): string {
  const start = toOklch(css);
  if (!start) return css;
  let { l } = start;
  for (let i = 0; i < 100; i++) {
    const rgb = cssToSrgb(formatOklch(l, start.c, start.h));
    if (rgb && contrast(rgb, against) >= ratio) break;
    const next = toward === "lighter" ? l + 0.01 : l - 0.01;
    if (next < 0 || next > 1) break;
    l = next;
  }
  return formatOklch(l, start.c, start.h);
}
