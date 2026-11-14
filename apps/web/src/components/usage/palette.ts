import type { ChartConfig } from "@/components/ui/chart";

/**
 * Categorical series colors, validated for colour-vision deficiency on adjacent pairs in both
 * themes (each theme has its own steps). A ninth value is never a new hue: it folds into the
 * neutral "Other" series.
 */
export const SERIES_COLORS: { light: string; dark: string }[] = [
  { light: "#2a78d6", dark: "#3987e5" },
  { light: "#eb6834", dark: "#d95926" },
  { light: "#1baf7a", dark: "#199e70" },
  { light: "#eda100", dark: "#c98500" },
  { light: "#e87ba4", dark: "#d55181" },
  { light: "#008300", dark: "#008300" },
  { light: "#6250d6", dark: "#9085e9" },
  { light: "#e34948", dark: "#e66767" },
];

export const OTHER_COLOR = { light: "#a3a29c", dark: "#6b6a65" };

/** Token categories in the tokens chart, in stacking order. */
export const TOKEN_KINDS = [
  { key: "input", label: "Input", slot: 0 },
  { key: "cacheWrite", label: "Cache writes", slot: 1 },
  { key: "cacheRead", label: "Cache reads", slot: 2 },
  { key: "output", label: "Output", slot: 6 },
] as const;

/** Providers keep the same color everywhere. */
const FIXED_SLOTS: Record<string, number> = {
  codex: 0,
  claude: 1,
  opencode: 2,
  cursor: 3,
  gemini: 4,
};

/**
 * A color slot per key. Providers have fixed slots; other values take the remaining slots in
 * palette order, in the order given (largest first), so neighbouring segments keep the
 * palette's validated contrast. The ninth value onwards is "Other" (neutral).
 */
export function colorSlots(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of keys) {
    const slot = FIXED_SLOTS[key];
    if (slot !== undefined && !taken.has(slot)) {
      out.set(key, slot);
      taken.add(slot);
    }
  }
  let next = 0;
  for (const key of keys) {
    if (out.has(key) || key === "__other") continue;
    while (taken.has(next) && next < SERIES_COLORS.length) next++;
    if (next >= SERIES_COLORS.length) break;
    out.set(key, next);
    taken.add(next);
  }
  return out;
}

/** CSS-safe chart config key for a series key. */
export function seriesVar(index: number): string {
  return `s${index}`;
}

/** Chart config for a list of series (keys in display order). */
export function chartConfig(series: { key: string; label: string }[]): ChartConfig {
  const slots = colorSlots(series.map((s) => s.key));
  const config: ChartConfig = {};
  series.forEach((s, i) => {
    const slot = slots.get(s.key);
    const theme =
      s.key === "__other" || slot === undefined
        ? OTHER_COLOR
        : (SERIES_COLORS[slot] ?? OTHER_COLOR);
    config[seriesVar(i)] = { label: s.label, theme };
  });
  return config;
}
