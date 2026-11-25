import type { AppearanceSettings, ThemePresetId, ThemeTokenOverrides } from "@codeden/contracts";
import { customTokens } from "./derive";
import { THEME_PRESETS, type ThemeKind, type ThemePreset } from "./presets";
import { THEME_VARIABLES, type ThemeTokens } from "./tokens";

/** The theme filling one slot, colours resolved. */
export interface ResolvedTheme {
  kind: ThemeKind;
  /** The preset, or `custom`. */
  choice: ThemePresetId | "custom";
  name: string;
  /** The preset a custom theme starts from (the preset itself otherwise). */
  base: ThemePreset;
  tokens: ThemeTokens;
  /**
   * CodeDen's own theme, unchanged: nothing is set on `<html>` but the `dark` class, so the
   * stylesheet's colours apply exactly as designed.
   */
  builtIn: boolean;
}

/** The theme in the `kind` slot of `appearance`. */
export function slotTheme(appearance: AppearanceSettings, kind: ThemeKind): ResolvedTheme {
  const choice = kind === "dark" ? appearance.darkTheme : appearance.lightTheme;
  return themeFor(kind, choice, appearance.custom[kind]);
}

/** A slot's theme from its choice and its custom theme. */
export function themeFor(
  kind: ThemeKind,
  choice: ThemePresetId | "custom",
  custom: { base: ThemePresetId; tokens: ThemeTokenOverrides },
): ResolvedTheme {
  if (choice !== "custom") {
    const preset = THEME_PRESETS[choice];
    return {
      kind,
      choice,
      name: preset.name,
      base: preset,
      tokens: preset.tokens,
      builtIn: preset.builtIn,
    };
  }
  const base = THEME_PRESETS[custom.base];
  const changed = Object.keys(custom.tokens).length > 0;
  return {
    kind,
    choice,
    name: `Custom ${kind}`,
    base,
    tokens: changed ? customTokens(base.tokens, kind, custom.tokens) : base.tokens,
    builtIn: base.builtIn && !changed,
  };
}

/** Which slot shows: the mode, `system` resolved against the OS. */
export function activeKind(mode: AppearanceSettings["theme"], systemDark: boolean): ThemeKind {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

/** What the boot script (`public/theme-boot.js`) applies before the app loads. */
export interface ThemeBoot {
  mode: AppearanceSettings["theme"];
  dark: BootSlot;
  light: BootSlot;
}
interface BootSlot {
  /** `data-theme` on `<html>`; null for CodeDen's own theme. */
  theme: string | null;
  vars: Partial<ThemeTokens> | null;
}

export const BOOT_KEY = "codeden.theme.boot";

export function bootOf(appearance: AppearanceSettings): ThemeBoot {
  const slot = (kind: ThemeKind): BootSlot => {
    const t = slotTheme(appearance, kind);
    return t.builtIn ? { theme: null, vars: null } : { theme: t.choice, vars: t.tokens };
  };
  return { mode: appearance.theme, dark: slot("dark"), light: slot("light") };
}

/**
 * Puts `theme` on `<html>`: the `dark` class for its kind, and for any theme but CodeDen's own,
 * every colour variable inline plus `data-theme` (which `index.css` uses for the few rules a
 * variable can't reach). Listeners that read the variables (the Factory Floor) watch `class`
 * and `style`.
 */
export function applyResolvedTheme(theme: ResolvedTheme, root = document.documentElement): void {
  for (const v of THEME_VARIABLES) {
    if (theme.builtIn) root.style.removeProperty(`--${v}`);
    else root.style.setProperty(`--${v}`, theme.tokens[v]);
  }
  if (theme.builtIn) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme.choice);
  root.classList.toggle("dark", theme.kind === "dark");
}
