import { useState } from "react";
import type { ThemeKind } from "@/lib/theme/presets";
import { type ThemePreference, useThemeStore } from "@/stores/theme";
import { Segmented, SettingRow, SettingsSection } from "./settings-ui";
import { ThemeCards } from "./theme/theme-cards";
import { ThemeEditor } from "./theme/theme-editor";

const SLOT_HELP: Record<ThemeKind, string> = {
  dark: "Used in dark mode, and in System mode when your OS is dark.",
  light: "Used in light mode, and in System mode when your OS is light.",
};

/** One slot's cards, with its custom theme's editor below them when open. */
function ThemeSlot({ kind }: { kind: ThemeKind }) {
  const choice = useThemeStore((s) => (kind === "dark" ? s.darkTheme : s.lightTheme));
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection
      title={kind === "dark" ? "Dark theme" : "Light theme"}
      description={SLOT_HELP[kind]}
    >
      <div className="@container p-4">
        <ThemeCards kind={kind} onEdit={() => setEditing(true)} />
      </div>
      {editing && choice === "custom" && (
        <div className="@container">
          <ThemeEditor kind={kind} onClose={() => setEditing(false)} />
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * Appearance (§14): the mode, then a theme for each mode. The mode picks the slot (dark, light,
 * or whichever the OS prefers), and each slot holds a preset of its kind or a custom theme, so
 * System always switches between a dark and a light theme.
 */
export function AppearanceSettings() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  return (
    <>
      <SettingsSection title="Mode">
        <SettingRow
          label="Theme mode"
          help="Dark is the default. System follows your OS and switches between the two themes below."
        >
          <Segmented<ThemePreference>
            value={preference}
            onChange={setPreference}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
        </SettingRow>
      </SettingsSection>
      <ThemeSlot kind="dark" />
      <ThemeSlot kind="light" />
    </>
  );
}
