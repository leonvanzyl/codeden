import {
  THEME_TOKEN_KEYS,
  ThemeColor,
  type ThemePresetId,
  type ThemeTokenKey,
} from "@codeden/contracts";
import { CircleAlert, CircleCheck, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { auditContrast } from "@/lib/theme/contrast";
import { keyColor } from "@/lib/theme/derive";
import { presetsOf, type ThemeKind } from "@/lib/theme/presets";
import { themeFor } from "@/lib/theme/resolve";
import { KEY_LABELS } from "@/lib/theme/tokens";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { ThemePreview } from "./theme-preview";

/** One colour: a colour input, its hex code (editable) and a reset to the preset's colour. */
function ColorRow({
  id,
  value,
  changed,
  onChange,
  onReset,
}: {
  id: ThemeTokenKey;
  value: string;
  changed: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const { label, help } = KEY_LABELS[id];
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const parsed = ThemeColor.safeParse(draft.startsWith("#") ? draft : `#${draft}`);
    if (parsed.success) onChange(parsed.data);
    else setDraft(value);
  };
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} colour`}
        className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5 [&::-moz-color-swatch]:rounded-[4px] [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {label}
          {changed && (
            <span className="rounded-sm bg-primary/15 px-1 text-3xs font-normal text-foreground">
              Changed
            </span>
          )}
        </div>
        <div className="truncate text-2xs text-muted-foreground">{help}</div>
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        spellCheck={false}
        aria-label={`${label} hex code`}
        className="h-7 w-[5.5rem] shrink-0 rounded-md border border-input bg-background px-1.5 font-mono text-xs uppercase outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onReset}
        disabled={!changed}
        aria-label={`Reset ${label} to the preset`}
        title="Reset to the preset"
        className={cn(!changed && "invisible")}
      >
        <RotateCcw />
      </Button>
    </div>
  );
}

/** Which WCAG AA checks the theme fails, or that it passes them all. */
function ContrastReport({ results }: { results: ReturnType<typeof auditContrast> }) {
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 shrink-0 text-status-done" aria-hidden />
        All {results.length} text and control pairs meet WCAG 2.2 AA contrast.
      </p>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <CircleAlert className="size-3.5 shrink-0 text-status-waiting" aria-hidden />
        {failed.length} of {results.length} pairs fall below WCAG 2.2 AA contrast:
      </p>
      <ul className="ml-5 list-disc space-y-0.5 text-muted-foreground">
        {failed.slice(0, 6).map((r) => (
          <li key={r.label}>
            {r.label}: {r.ratio.toFixed(2)}:1 (needs {r.min}:1)
          </li>
        ))}
        {failed.length > 6 && <li>and {failed.length - 6} more</li>}
      </ul>
    </div>
  );
}

/**
 * The editor for one slot's custom theme: a preset to start from, the few colours that can be
 * changed (the rest follow them), a live preview and the contrast check. Every change applies
 * to the app at once and is saved to the settings.
 */
export function ThemeEditor({ kind, onClose }: { kind: ThemeKind; onClose: () => void }) {
  const custom = useThemeStore((s) => s.custom[kind]);
  const setCustom = useThemeStore((s) => s.setCustom);
  const choose = useThemeStore((s) => s.choose);
  const theme = useMemo(() => themeFor(kind, "custom", custom), [kind, custom]);
  const results = useMemo(() => auditContrast(theme.tokens), [theme]);
  const save = (next: typeof custom) => {
    setCustom(kind, next as never);
    choose(kind, "custom");
  };
  const setKey = (key: ThemeTokenKey, hex: string | null) => {
    const tokens = { ...custom.tokens };
    if (hex === null) delete tokens[key];
    else tokens[key] = hex;
    save({ ...custom, tokens });
  };
  const changed = Object.keys(custom.tokens).length > 0;

  return (
    <div className="p-4" data-testid={`theme-editor-${kind}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-[13.5px] font-semibold">Custom {kind} theme</h3>
        <span className="text-xs text-muted-foreground">Start from</span>
        <Select
          value={custom.base}
          onValueChange={(v) => save({ ...custom, base: v as ThemePresetId } as typeof custom)}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Preset to start from">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presetsOf(kind).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          size="sm"
          disabled={!changed}
          onClick={() => save({ ...custom, tokens: {} })}
        >
          <RotateCcw />
          Reset all
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the editor">
          <X />
        </Button>
      </div>
      <div className="grid gap-5 @[52rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="divide-y divide-border/60">
          {THEME_TOKEN_KEYS.map((key) => (
            <ColorRow
              key={key}
              id={key}
              value={keyColor(theme.tokens, key)}
              changed={custom.tokens[key] !== undefined}
              onChange={(hex) => setKey(key, hex)}
              onReset={() => setKey(key, null)}
            />
          ))}
        </div>
        <div className="space-y-3">
          <div className="@container">
            <ThemePreview tokens={theme.tokens} kind={kind} />
          </div>
          <ContrastReport results={results} />
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Cards, the sidebar, panels and input outlines follow the background, text and border you
            pick. Changes apply as you make them and are saved for every window.
          </p>
        </div>
      </div>
    </div>
  );
}
