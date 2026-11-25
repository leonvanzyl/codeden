import { Check } from "lucide-react";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { THEME_PRESETS, type ThemeKind } from "@/lib/theme/presets";
import { themeFor } from "@/lib/theme/resolve";
import type { ThemeTokens } from "@/lib/theme/tokens";
import { useThemeStore } from "@/stores/theme";

/** Three dots of a theme's own colours: page, text and accent. */
export function ThemeDots({ tokens }: { tokens: ThemeTokens }) {
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 items-center overflow-hidden rounded-full border border-border"
      style={{ background: tokens.background }}
    >
      <span className="h-full w-1/2" style={{ background: tokens.primary }} />
      <span className="h-full w-1/2" style={{ background: tokens.foreground }} />
    </span>
  );
}

/**
 * The palette's "Theme" group: every preset and each custom theme. Picking one puts it in its
 * slot (dark or light) and shows that slot, unless the mode follows the system.
 */
export function PaletteThemes({ close }: { close: () => void }) {
  const state = useThemeStore();
  const rows: { kind: ThemeKind; choice: string; name: string; tokens: ThemeTokens }[] = [
    ...Object.values(THEME_PRESETS).map((p) => ({
      kind: p.kind,
      choice: p.id as string,
      name: p.name,
      tokens: p.tokens,
    })),
    ...(["dark", "light"] as const).map((kind) => {
      const t = themeFor(kind, "custom", state.custom[kind]);
      return { kind, choice: "custom", name: t.name, tokens: t.tokens };
    }),
  ];
  return (
    <CommandGroup heading="Theme">
      {rows.map((r) => {
        const active = (r.kind === "dark" ? state.darkTheme : state.lightTheme) === r.choice;
        return (
          <CommandItem
            key={`${r.kind}:${r.choice}`}
            value={`theme ${r.name} ${r.kind} colours appearance`}
            className="gap-2.5"
            onSelect={() => {
              close();
              state.choose(r.kind, r.choice as never);
            }}
          >
            <ThemeDots tokens={r.tokens} />
            <span className="min-w-0 truncate">Theme: {r.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {r.kind === "dark" ? "Dark" : "Light"}
            </span>
            <span className="flex-1" />
            {active && <Check className="size-3.5 text-muted-foreground" aria-label="In use" />}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
