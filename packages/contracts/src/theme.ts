import { z } from "zod";

/**
 * Appearance settings (§14 Global): the light/dark mode, which theme each mode uses, and the
 * user's custom themes. The colours themselves live in the web app (`apps/web/src/lib/theme/`);
 * the contracts only name the presets and validate the user's choices.
 *
 * How presets map to the mode: `theme` (`dark`, `light`, `system`) picks the dark or the light
 * slot, exactly as before presets existed; `darkTheme` and `lightTheme` say which theme fills
 * each slot. A slot only takes themes of its own kind, so `system` always gets a dark theme
 * when the OS is dark and a light one when it is light.
 */

/** Built-in dark themes. `codeden-dark` is CodeDen's own dark theme and the default. */
export const DARK_THEME_PRESETS = ["codeden-dark", "contrast-dark", "hearth", "dusk"] as const;
/** Built-in light themes. `codeden-light` is CodeDen's own light theme and the default. */
export const LIGHT_THEME_PRESETS = ["codeden-light", "contrast-light"] as const;

export const DarkThemePreset = z.enum(DARK_THEME_PRESETS);
export type DarkThemePreset = z.infer<typeof DarkThemePreset>;
export const LightThemePreset = z.enum(LIGHT_THEME_PRESETS);
export type LightThemePreset = z.infer<typeof LightThemePreset>;
export const ThemePresetId = z.enum([...DARK_THEME_PRESETS, ...LIGHT_THEME_PRESETS]);
export type ThemePresetId = z.infer<typeof ThemePresetId>;

/** The theme in a slot: a preset of the slot's kind, or the slot's custom theme. */
export const DarkThemeChoice = z.union([DarkThemePreset, z.literal("custom")]);
export type DarkThemeChoice = z.infer<typeof DarkThemeChoice>;
export const LightThemeChoice = z.union([LightThemePreset, z.literal("custom")]);
export type LightThemeChoice = z.infer<typeof LightThemeChoice>;

/**
 * The colours a custom theme can override, kept small on purpose. Everything else (cards,
 * popovers, the sidebar, hover and input outlines, charts, diff colours) is derived from these
 * by the web app, so a custom theme stays coherent:
 * - `background`: the page; surfaces (cards, sidebar, panels) are derived from it.
 * - `foreground`: body text.
 * - `mutedText`: secondary text (timestamps, help, placeholders).
 * - `primary`: the accent (buttons, links, focus ring, selection).
 * - `border`: dividers and outlines; input outlines are derived from it.
 * - `running`, `waiting`, `done`, `failed`: session status colours; `done` and `failed` also
 *   colour added and removed lines in diffs, and `failed` destructive actions.
 */
export const THEME_TOKEN_KEYS = [
  "background",
  "foreground",
  "mutedText",
  "primary",
  "border",
  "running",
  "waiting",
  "done",
  "failed",
] as const;
export const ThemeTokenKey = z.enum(THEME_TOKEN_KEYS);
export type ThemeTokenKey = z.infer<typeof ThemeTokenKey>;

/** An opaque sRGB colour as `#rrggbb` (what a colour input gives), stored in lower case. */
export const ThemeColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected a colour like #1a2b3c")
  .toLowerCase();
export type ThemeColor = z.infer<typeof ThemeColor>;

/** A custom theme's overrides: only the keys the user changed. Unknown keys are refused. */
export const ThemeTokenOverrides = z.partialRecord(ThemeTokenKey, ThemeColor);
export type ThemeTokenOverrides = z.infer<typeof ThemeTokenOverrides>;

/** A custom dark theme: a dark preset to start from, plus the colours the user changed. */
export const CustomDarkTheme = z.object({
  base: DarkThemePreset.default("codeden-dark"),
  tokens: ThemeTokenOverrides.default({}),
});
export type CustomDarkTheme = z.infer<typeof CustomDarkTheme>;

/** A custom light theme: a light preset to start from, plus the colours the user changed. */
export const CustomLightTheme = z.object({
  base: LightThemePreset.default("codeden-light"),
  tokens: ThemeTokenOverrides.default({}),
});
export type CustomLightTheme = z.infer<typeof CustomLightTheme>;

/** `settings.appearance`. Every field has a default, so older settings files keep loading. */
export const AppearanceSettings = z.object({
  /** Which slot is shown: dark (the default), light, or whichever the OS prefers. */
  theme: z.enum(["system", "dark", "light"]).default("dark"),
  /** The theme used in dark mode. */
  darkTheme: DarkThemeChoice.default("codeden-dark"),
  /** The theme used in light mode. */
  lightTheme: LightThemeChoice.default("codeden-light"),
  /** The custom theme of each slot, used when that slot's choice is `custom`. */
  custom: z
    .object({
      dark: CustomDarkTheme.prefault({}),
      light: CustomLightTheme.prefault({}),
    })
    .prefault({}),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;
export type ThemeMode = AppearanceSettings["theme"];
