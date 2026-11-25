/**
 * OKLCH to sRGB, for code that needs numbers rather than CSS strings: the theme's colours are
 * written as `oklch()`, which a canvas understands but WebGL colour objects don't. Pure.
 */

/** An sRGB colour, each channel gamma-encoded in 0..1. */
export type Rgb = [r: number, g: number, b: number];

export interface Oklch {
  /** Lightness, 0..1. */
  l: number;
  /** Chroma, about 0..0.4. */
  c: number;
  /** Hue in degrees. */
  h: number;
  /** Opacity, 0..1. */
  alpha: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Linear light to the sRGB transfer curve. */
function encode(x: number): number {
  const v = clamp01(x);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * An OKLCH colour as gamma-encoded sRGB. Colours outside the sRGB gamut are clipped per
 * channel, as browsers do for `oklch()` on an sRGB screen.
 */
export function oklchToSrgb(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  return [
    encode(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    encode(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    encode(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

const NUMBER = String.raw`(-?[\d.]+)`;
const OKLCH = new RegExp(
  String.raw`^oklch\(\s*${NUMBER}(%?)\s+${NUMBER}(%?)\s+${NUMBER}(?:deg)?\s*(?:/\s*${NUMBER}(%?)\s*)?\)$`,
  "i",
);

/** Reads `oklch(0.66 0.165 58)`, `oklch(66% 0.165 58deg / 50%)` and the like; null otherwise. */
export function parseOklch(css: string): Oklch | null {
  const m = OKLCH.exec(css.trim());
  if (!m) return null;
  const [, l, lPct, c, cPct, h, alpha, alphaPct] = m;
  const num = (s: string | undefined) => Number.parseFloat(s ?? "");
  const values = {
    l: lPct ? num(l) / 100 : num(l),
    // Per CSS Color 4, 100% chroma is 0.4.
    c: cPct ? (num(c) / 100) * 0.4 : num(c),
    h: num(h),
    alpha: alpha === undefined ? 1 : alphaPct ? num(alpha) / 100 : num(alpha),
  };
  if (Object.values(values).some((v) => Number.isNaN(v))) return null;
  return {
    ...values,
    l: clamp01(values.l),
    c: Math.max(0, values.c),
    alpha: clamp01(values.alpha),
  };
}

/** Reads `#rgb`, `#rrggbb` (alpha ignored) or `oklch(…)` as sRGB; null for anything else. */
export function cssToSrgb(css: string): Rgb | null {
  const s = css.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/i.exec(s);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((ch) => ch + ch).join("") : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
  }
  const o = parseOklch(s);
  return o ? oklchToSrgb(o.l, o.c, o.h) : null;
}

/** An sRGB colour as `#rrggbb`, for canvas drawing. */
export function srgbToHex([r, g, b]: Rgb): string {
  const byte = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The sRGB transfer curve back to linear light. */
function decode(x: number): number {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Gamma-encoded sRGB as OKLCH (hue 0 for greys); the inverse of `oklchToSrgb`. */
export function srgbToOklch([r, g, b]: Rgb): Omit<Oklch, "alpha"> {
  const R = decode(r);
  const G = decode(g);
  const B = decode(b);
  const l_ = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m_ = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s_ = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const Bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, Bk);
  const h = c < 1e-4 ? 0 : ((Math.atan2(Bk, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}
