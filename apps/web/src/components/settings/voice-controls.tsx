import { Keyboard, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatCombo, leavesTypingAlone } from "@/lib/shortcuts";
import { SettingRow, useSettings } from "./settings-ui";

/** A combo from a key event, e.g. `mod+shift+space` (modifier-only presses return null). */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key =
    e.key === " " ? "space" : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

export function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  // `needsModifier` after a key on its own (Space, a letter, Enter): it would take that key over
  // in every text field, so the recorder asks for Ctrl/⌘ or Alt with it.
  const [recording, setRecording] = useState<false | "keys" | "needsModifier">(false);
  const label =
    recording === "keys"
      ? "Press keys…"
      : recording === "needsModifier"
        ? `Add ${formatCombo("mod")} or ${formatCombo("alt")}…`
        : value
          ? formatCombo(value)
          : "Not set";
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        aria-label="Push-to-talk shortcut"
        className="min-w-36 font-mono text-xs"
        onClick={() => setRecording("keys")}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          if (e.key === "Escape") return setRecording(false);
          const combo = comboFromEvent(e);
          if (!combo) return;
          if (!leavesTypingAlone(combo)) return setRecording("needsModifier");
          onChange(combo);
          setRecording(false);
        }}
      >
        <Keyboard /> {label}
      </Button>
      {value && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Clear push-to-talk"
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

export function QuietHoursRow() {
  const { settings, update } = useSettings();
  const quiet = settings.voice.readAloud.quietHours;
  const set = (patch: { start?: string; end?: string }) =>
    quiet && update({ voice: { readAloud: { quietHours: { ...quiet, ...patch } } } });
  return (
    <SettingRow label="Quiet hours" help="Nothing is spoken in this window.">
      <div className="flex items-center gap-2">
        <Switch
          aria-label="Quiet hours"
          checked={quiet !== null}
          onCheckedChange={(on) =>
            update({
              voice: { readAloud: { quietHours: on ? { start: "22:00", end: "07:00" } : null } },
            })
          }
        />
        <Input
          type="time"
          aria-label="Quiet hours start"
          disabled={!quiet}
          value={quiet?.start ?? "22:00"}
          onChange={(e) => set({ start: e.target.value })}
          className="h-8 w-24 text-xs"
        />
        <span className="text-2xs text-muted-foreground">to</span>
        <Input
          type="time"
          aria-label="Quiet hours end"
          disabled={!quiet}
          value={quiet?.end ?? "07:00"}
          onChange={(e) => set({ end: e.target.value })}
          className="h-8 w-24 text-xs"
        />
      </div>
    </SettingRow>
  );
}
