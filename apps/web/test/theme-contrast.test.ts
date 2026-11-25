import { describe, expect, it } from "vitest";
import { cssToSrgb, type Rgb } from "@/lib/oklch";
import { composite, contrast, toOklch } from "@/lib/theme/color";
import { auditContrast } from "@/lib/theme/contrast";
import { customTokens } from "@/lib/theme/derive";
import { THEME_PRESETS } from "@/lib/theme/presets";

const rgb = (css: string) => cssToSrgb(css) as Rgb;

describe("WCAG contrast", () => {
  it("measures known pairs", () => {
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrast([1, 1, 1], [1, 1, 1])).toBe(1);
    // #767676 is the classic lightest grey that passes 4.5:1 on white; #777777 just fails.
    expect(contrast(rgb("#767676"), [1, 1, 1])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb("#777777"), [1, 1, 1])).toBeLessThan(4.5);
  });

  it("paints translucent colours over what is below them", () => {
    const seen = composite("oklch(1 0 0 / 50%)", [0, 0, 0]) as Rgb;
    for (const v of seen) expect(v).toBeCloseTo(0.5, 5);
  });
});

describe("built-in themes meet WCAG 2.2 AA", () => {
  const added = Object.values(THEME_PRESETS).filter((p) => !p.builtIn);

  it.each(added.map((p) => [p.name, p] as const))("%s", (_, preset) => {
    const failed = auditContrast(preset.tokens).filter((r) => !r.pass);
    expect(failed.map((r) => `${r.label}: ${r.ratio}`)).toEqual([]);
  });

  it("high contrast themes keep body and muted text well above the minimum", () => {
    for (const id of ["contrast-dark", "contrast-light"] as const) {
      const results = auditContrast(THEME_PRESETS[id].tokens);
      const ratio = (label: string) => results.find((r) => r.label === label)?.ratio ?? 0;
      expect(ratio("Text on background"), id).toBeGreaterThanOrEqual(7);
      expect(ratio("Muted text on background"), id).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("custom themes", () => {
  const dark = THEME_PRESETS["codeden-dark"].tokens;

  it("change only what depends on an overridden colour", () => {
    const t = customTokens(dark, "dark", { mutedText: "#a0a0b0" });
    expect(t["muted-foreground"]).toBe("#a0a0b0");
    const others = Object.entries(t).filter(([k]) => k !== "muted-foreground");
    expect(Object.fromEntries(others)).toEqual(
      Object.fromEntries(Object.entries(dark).filter(([k]) => k !== "muted-foreground")),
    );
  });

  it("move the surfaces with the background, keeping their steps", () => {
    const t = customTokens(dark, "dark", { background: "#202a33" });
    const step = (v: "card" | "sidebar", tokens: typeof dark) =>
      (toOklch(tokens[v])?.l ?? 0) - (toOklch(tokens.background)?.l ?? 0);
    expect(step("card", t)).toBeCloseTo(step("card", dark), 2);
    expect(step("sidebar", t)).toBeCloseTo(step("sidebar", dark), 2);
  });

  it("pick readable button text for the accent and keep input outlines at 3:1", () => {
    for (const primary of ["#ffd166", "#1d3557", "#e63946", "#2a9d8f"]) {
      const t = customTokens(dark, "dark", { primary });
      expect(contrast(rgb(t["primary-foreground"]), rgb(primary))).toBeGreaterThanOrEqual(4.5);
    }
    const t = customTokens(dark, "dark", { border: "#23262d" });
    expect(contrast(rgb(t.input), rgb(t.background))).toBeGreaterThanOrEqual(3);
    const light = THEME_PRESETS["codeden-light"].tokens;
    const l = customTokens(light, "light", { border: "#f0f0f0" });
    expect(contrast(rgb(l.input), rgb(l.background))).toBeGreaterThanOrEqual(3);
  });

  it("carry status colours into diffs and destructive actions", () => {
    const t = customTokens(dark, "dark", { done: "#33cc66", failed: "#ff5566" });
    expect(t["diff-add"]).toBe("#33cc66");
    expect(t["diff-del"]).toBe("#ff5566");
    expect(t.destructive).toBe("#ff5566");
  });

  it("are flagged when they fall below AA", () => {
    const t = customTokens(dark, "dark", { foreground: "#3a3a3a" });
    const failed = auditContrast(t).filter((r) => !r.pass);
    expect(failed.some((r) => r.label === "Text on background")).toBe(true);
  });
});
