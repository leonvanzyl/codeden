import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DARK_THEME_PRESETS, LIGHT_THEME_PRESETS } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { cssToSrgb } from "@/lib/oklch";
import { CODEDEN_DARK, CODEDEN_LIGHT } from "@/lib/theme/codeden-tokens";
import { THEME_PRESETS } from "@/lib/theme/presets";
import { bootOf, slotTheme } from "@/lib/theme/resolve";
import { THEME_VARIABLES } from "@/lib/theme/tokens";

const css = readFileSync(resolve(import.meta.dirname, "../src/index.css"), "utf8");

/** The colour variables a top-level rule in `index.css` declares. */
function declared(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars = Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
  );
  delete vars.radius;
  return vars;
}

describe("theme presets", () => {
  it("mirror CodeDen's own light and dark themes exactly as index.css declares them", () => {
    // CodeDen Light and Dark are the stylesheet's; the copies here only feed the swatches, the
    // editor and the contrast report, so they must never drift.
    expect(CODEDEN_LIGHT).toEqual(declared(":root"));
    expect(CODEDEN_DARK).toEqual(declared(".dark"));
  });

  it("set every colour variable the stylesheet declares, each one readable", () => {
    expect([...THEME_VARIABLES].sort()).toEqual(Object.keys(declared(".dark")).sort());
    for (const preset of Object.values(THEME_PRESETS)) {
      expect(Object.keys(preset.tokens).sort(), preset.id).toEqual([...THEME_VARIABLES].sort());
      for (const v of THEME_VARIABLES)
        expect(cssToSrgb(preset.tokens[v]), `${preset.id} ${v}`).not.toBeNull();
    }
  });

  it("match the contracts' preset ids and kinds", () => {
    const ids = (kind: string) =>
      Object.values(THEME_PRESETS)
        .filter((p) => p.kind === kind)
        .map((p) => p.id);
    expect(ids("dark")).toEqual([...DARK_THEME_PRESETS]);
    expect(ids("light")).toEqual([...LIGHT_THEME_PRESETS]);
  });

  it("leave CodeDen's own themes to the stylesheet: no variables, no data-theme", () => {
    const defaults = {
      theme: "dark",
      darkTheme: "codeden-dark",
      lightTheme: "codeden-light",
      custom: {
        dark: { base: "codeden-dark", tokens: {} },
        light: { base: "codeden-light", tokens: {} },
      },
    } as const;
    expect(slotTheme(defaults, "dark").builtIn).toBe(true);
    // A custom theme with nothing changed is still CodeDen's own.
    expect(slotTheme({ ...defaults, darkTheme: "custom" }, "dark").builtIn).toBe(true);
    expect(bootOf(defaults)).toEqual({
      mode: "dark",
      dark: { theme: null, vars: null },
      light: { theme: null, vars: null },
    });
    const hearth = bootOf({ ...defaults, darkTheme: "hearth" });
    expect(hearth.dark.theme).toBe("hearth");
    expect(hearth.dark.vars).toEqual(THEME_PRESETS.hearth.tokens);
  });
});
