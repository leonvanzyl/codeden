import { Check, Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { presetsOf, type ThemeKind } from "@/lib/theme/presets";
import { themeFor } from "@/lib/theme/resolve";
import type { ThemeTokens } from "@/lib/theme/tokens";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { ThemeSwatch } from "./theme-preview";

interface CardProps {
  name: string;
  description: string;
  tokens: ThemeTokens;
  kind: ThemeKind;
  selected: boolean;
  onSelect: () => void;
  /** "Customize": start a custom theme from this one. */
  onCustomize?: () => void;
}

function ThemeCard({
  name,
  description,
  tokens,
  kind,
  selected,
  onSelect,
  onCustomize,
}: CardProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col gap-2 rounded-lg border bg-background/40 p-2 text-left transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-ring",
          selected ? "border-primary ring-1 ring-primary" : "border-border",
        )}
      >
        <ThemeSwatch tokens={tokens} kind={kind} />
        <div className="flex items-start gap-1.5 px-0.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{name}</div>
            <div className="line-clamp-2 text-2xs leading-snug text-muted-foreground">
              {description}
            </div>
          </div>
          {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
        </div>
      </button>
      {onCustomize && (
        <Button
          variant="secondary"
          size="icon-xs"
          className="absolute top-3.5 right-3.5 opacity-0 shadow-sm group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100"
          onClick={onCustomize}
          aria-label={`Customize ${name}`}
          title={`Customize ${name}`}
        >
          <Paintbrush />
        </Button>
      )}
    </div>
  );
}

/**
 * The themes for one slot (dark or light) as cards: the presets of that kind and the slot's
 * custom theme. `onEdit` opens the custom theme's editor.
 */
export function ThemeCards({ kind, onEdit }: { kind: ThemeKind; onEdit: () => void }) {
  const choice = useThemeStore((s) => (kind === "dark" ? s.darkTheme : s.lightTheme));
  const custom = useThemeStore((s) => s.custom[kind]);
  const choose = useThemeStore((s) => s.choose);
  const setCustom = useThemeStore((s) => s.setCustom);
  const customTheme = themeFor(kind, "custom", custom);
  const changed = Object.keys(custom.tokens).length;
  return (
    <fieldset
      aria-label={`${kind === "dark" ? "Dark" : "Light"} theme`}
      className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0 @[36rem]:grid-cols-3 @[52rem]:grid-cols-4"
    >
      {presetsOf(kind).map((p) => (
        <ThemeCard
          key={p.id}
          name={p.name}
          description={p.description}
          tokens={p.tokens}
          kind={kind}
          selected={choice === p.id}
          onSelect={() => choose(kind, p.id)}
          onCustomize={() => {
            setCustom(kind, { base: p.id, tokens: {} } as never);
            choose(kind, "custom");
            onEdit();
          }}
        />
      ))}
      <ThemeCard
        name={customTheme.name}
        description={
          changed
            ? `${customTheme.base.name} with ${changed} colour${changed === 1 ? "" : "s"} changed.`
            : `Starts from ${customTheme.base.name}. Pick your own colours.`
        }
        tokens={customTheme.tokens}
        kind={kind}
        selected={choice === "custom"}
        onSelect={() => {
          choose(kind, "custom");
          onEdit();
        }}
      />
    </fieldset>
  );
}
