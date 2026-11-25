import type { ThemePresetId } from "@codeden/contracts";
import { CODEDEN_DARK, CODEDEN_LIGHT } from "./codeden-tokens";
import { CONTRAST_DARK, CONTRAST_LIGHT, DUSK, HEARTH } from "./preset-tokens";
import type { ThemeTokens } from "./tokens";

export type ThemeKind = "dark" | "light";

export interface ThemePreset {
  id: ThemePresetId;
  name: string;
  description: string;
  kind: ThemeKind;
  tokens: ThemeTokens;
  /**
   * CodeDen's own themes are the stylesheet's: applying one sets no variables at all, and the
   * terminal, diff and code views keep their original colours.
   */
  builtIn: boolean;
}

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  "codeden-dark": {
    id: "codeden-dark",
    name: "CodeDen Dark",
    description: "CodeDen's own dark theme: cool slate with an ember accent. The default.",
    kind: "dark",
    tokens: CODEDEN_DARK,
    builtIn: true,
  },
  "contrast-dark": {
    id: "contrast-dark",
    name: "High Contrast Dark",
    description: "Lifted slate with opaque outlines and brighter muted text, for bright rooms.",
    kind: "dark",
    tokens: CONTRAST_DARK,
    builtIn: false,
  },
  hearth: {
    id: "hearth",
    name: "Hearth",
    description: "Warm charcoal with a copper accent and cream text.",
    kind: "dark",
    tokens: HEARTH,
    builtIn: false,
  },
  dusk: {
    id: "dusk",
    name: "Dusk",
    description: "Soft, dim blue-violet with a sea-glass accent, easy on the eyes at night.",
    kind: "dark",
    tokens: DUSK,
    builtIn: false,
  },
  "codeden-light": {
    id: "codeden-light",
    name: "CodeDen Light",
    description: "CodeDen's own light theme, mirroring the dark one. The default.",
    kind: "light",
    tokens: CODEDEN_LIGHT,
    builtIn: true,
  },
  "contrast-light": {
    id: "contrast-light",
    name: "High Contrast Light",
    description: "White surfaces, near-black text, strong outlines and a deep amber accent.",
    kind: "light",
    tokens: CONTRAST_LIGHT,
    builtIn: false,
  },
};

/** The presets of one kind, CodeDen's own first. */
export function presetsOf(kind: ThemeKind): ThemePreset[] {
  return Object.values(THEME_PRESETS).filter((p) => p.kind === kind);
}
