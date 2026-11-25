import { describe, expect, it } from "vitest";
import { AppearanceSettings, defaultSettings, Settings, ThemeColor } from "../src";

describe("Settings.appearance (themes)", () => {
  it("defaults to CodeDen's own themes, so older settings files load unchanged", () => {
    expect(defaultSettings().appearance).toEqual({
      theme: "dark",
      darkTheme: "codeden-dark",
      lightTheme: "codeden-light",
      custom: {
        dark: { base: "codeden-dark", tokens: {} },
        light: { base: "codeden-light", tokens: {} },
      },
    });
    // Saved before presets existed: only the mode.
    const older = Settings.parse({ appearance: { theme: "light" } }).appearance;
    expect(older.theme).toBe("light");
    expect(older.darkTheme).toBe("codeden-dark");
    expect(older.lightTheme).toBe("codeden-light");
  });

  it("round-trips presets and custom themes", () => {
    const appearance = {
      theme: "system",
      darkTheme: "custom",
      lightTheme: "contrast-light",
      custom: {
        dark: { base: "hearth", tokens: { primary: "#ff8800", background: "#101010" } },
        light: { base: "contrast-light", tokens: { failed: "#b00020" } },
      },
    } as const;
    const parsed = Settings.parse({ appearance });
    expect(parsed.appearance).toEqual(appearance);
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("stores colours in lower case and refuses anything but #rrggbb", () => {
    expect(ThemeColor.parse("#A1B2C3")).toBe("#a1b2c3");
    for (const bad of ["red", "#abc", "#a1b2c3d4", "oklch(0.5 0.1 20)", "#ggg000", ""]) {
      expect(ThemeColor.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses unknown tokens, unknown presets and presets of the other kind", () => {
    const parse = (appearance: unknown) => AppearanceSettings.safeParse(appearance).success;
    expect(parse({ custom: { dark: { tokens: { sidebar: "#000000" } } } })).toBe(false);
    expect(parse({ darkTheme: "purple" })).toBe(false);
    // A slot only takes its own kind, so `system` always gets the right one.
    expect(parse({ darkTheme: "contrast-light" })).toBe(false);
    expect(parse({ lightTheme: "hearth" })).toBe(false);
    expect(parse({ custom: { light: { base: "codeden-dark" } } })).toBe(false);
    expect(parse({ custom: { dark: { tokens: { primary: "orange" } } } })).toBe(false);
  });
});
