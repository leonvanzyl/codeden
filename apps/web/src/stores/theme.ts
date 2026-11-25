import {
  AppearanceSettings,
  type CustomDarkTheme,
  type CustomLightTheme,
  type DarkThemeChoice,
  type LightThemeChoice,
  type ThemeMode,
} from "@codeden/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThemeKind } from "@/lib/theme/presets";
import {
  activeKind,
  applyResolvedTheme,
  BOOT_KEY,
  bootOf,
  type ResolvedTheme,
  slotTheme,
  themeFor,
} from "@/lib/theme/resolve";

export type ThemePreference = ThemeMode;

interface ThemeState {
  /** Dark, light or system: which slot shows (`settings.appearance.theme`). */
  preference: ThemePreference;
  darkTheme: DarkThemeChoice;
  lightTheme: LightThemeChoice;
  custom: AppearanceSettings["custom"];
  /**
   * The server's appearance as last saved or adopted (canonical JSON, `lib/theme/sync.ts`), so a
   * change made in another window is told apart from this one's. Null before the first sync.
   */
  synced: string | null;
  /** The OS prefers dark (not persisted). */
  systemDark: boolean;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
  /** Puts a theme in its slot, and shows that slot unless the mode follows the system. */
  choose: (kind: ThemeKind, choice: DarkThemeChoice | LightThemeChoice) => void;
  setCustom: (kind: ThemeKind, custom: CustomDarkTheme | CustomLightTheme) => void;
}

const systemPrefersDark = () =>
  typeof window === "undefined" || !window.matchMedia("(prefers-color-scheme: light)").matches;

/** Resolve `system` against the OS setting. */
export function resolveTheme(preference: ThemePreference): ThemeKind {
  return activeKind(preference, systemPrefersDark());
}

/** The appearance settings this window shows. */
export function appearanceOf(
  s: Pick<ThemeState, "preference" | "darkTheme" | "lightTheme" | "custom">,
): AppearanceSettings {
  return {
    theme: s.preference,
    darkTheme: s.darkTheme,
    lightTheme: s.lightTheme,
    custom: s.custom,
  };
}

/** The theme shown right now. */
export function currentTheme(s: ThemeState): ResolvedTheme {
  return slotTheme(appearanceOf(s), activeKind(s.preference, s.systemDark));
}

/**
 * Applies the current theme to `<html>` and keeps what the boot script needs to apply it again
 * before the next first paint.
 */
export function applyTheme(s: ThemeState): void {
  applyResolvedTheme(currentTheme(s));
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify(bootOf(appearanceOf(s))));
  } catch {
    // Storage full or blocked: the next load starts from the default and catches up.
  }
}

/** The kind (dark or light) shown right now. */
export function useResolvedTheme(): ThemeKind {
  return useThemeStore((s) => activeKind(s.preference, s.systemDark));
}

/** The theme shown right now, colours resolved. Stable while nothing about it changes. */
export function useCurrentTheme(): ResolvedTheme {
  const kind = useResolvedTheme();
  const choice = useThemeStore((s) => (kind === "dark" ? s.darkTheme : s.lightTheme));
  const custom = useThemeStore((s) => s.custom[kind]);
  return useMemo(() => themeFor(kind, choice, custom), [kind, choice, custom]);
}

const defaults = AppearanceSettings.parse({});

/**
 * Theme choices, kept in this browser (so they apply at once) and in `settings.json` (so every
 * window and the desktop app share them; `lib/theme/sync.ts`). Dark-first.
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preference: defaults.theme,
      darkTheme: defaults.darkTheme,
      lightTheme: defaults.lightTheme,
      custom: defaults.custom,
      synced: null,
      systemDark: systemPrefersDark(),
      setPreference: (preference) => set({ preference }),
      toggle: () =>
        set({ preference: resolveTheme(get().preference) === "dark" ? "light" : "dark" }),
      choose: (kind, choice) => {
        const slot =
          kind === "dark"
            ? { darkTheme: choice as DarkThemeChoice }
            : { lightTheme: choice as LightThemeChoice };
        set(get().preference === "system" ? slot : { ...slot, preference: kind });
      },
      setCustom: (kind, custom) => set({ custom: { ...get().custom, [kind]: custom } }),
    }),
    {
      name: "codeden.theme",
      partialize: (s) => ({
        preference: s.preference,
        darkTheme: s.darkTheme,
        lightTheme: s.lightTheme,
        custom: s.custom,
        synced: s.synced,
      }),
      // What this browser kept is validated like the settings file: anything unknown (an older
      // or newer version's theme) falls back to the defaults instead of breaking the page.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ThemeState>;
        const parsed = AppearanceSettings.safeParse({
          theme: p.preference,
          darkTheme: p.darkTheme,
          lightTheme: p.lightTheme,
          custom: p.custom,
        });
        if (!parsed.success) return current;
        const a = parsed.data;
        return {
          ...current,
          preference: a.theme,
          darkTheme: a.darkTheme,
          lightTheme: a.lightTheme,
          custom: a.custom,
          synced: typeof p.synced === "string" ? p.synced : null,
        };
      },
    },
  ),
);
