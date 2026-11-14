import type { UpdateStatus } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "@/components/shell/update-banner";
import { createMockClient } from "@/lib/api/mock";
import { SettingsPage } from "@/routes/settings";
import { renderWithClient } from "./utils";

/** A packaged install on 0.7.1 that sees 0.7.2 (the reported phone, #296). */
const available: UpdateStatus = {
  current: "0.7.1",
  latest: "0.7.2",
  updateAvailable: true,
  enabled: true,
  mode: "notify",
  checkedAt: "2026-11-14T10:00:00.000Z",
  error: null,
  command: "npm i -g codeden@latest",
  source: "packaged",
  state: "idle",
  target: null,
  progress: null,
  installError: null,
  canRestart: true,
  restartCommand: "npx codeden",
  installed: [],
  rollbackTo: null,
  canRollback: false,
  warning: null,
};

function clientWithUpdate() {
  const client = createMockClient();
  vi.spyOn(client, "getUpdates").mockResolvedValue(available);
  return client;
}

/**
 * Whether `el` has `base` by default and `wide` from a breakpoint up: `sm:` or a container query
 * such as `@[40rem]:`. jsdom has no layout, so the tests read the Tailwind classes.
 */
function narrowThenWide(el: Element | null | undefined, base: string, wide: string): boolean {
  const classes = [...(el?.classList ?? [])];
  return (
    classes.includes(base) &&
    classes.some((c) => /^(sm|@\[[\d.]+rem\]):/.test(c) && c.endsWith(`:${wide}`))
  );
}

/** A column on a phone (narrow), a row as before when there is room. */
const stacksOnPhones = (el: Element | null | undefined) =>
  narrowThenWide(el, "flex-col", "flex-row");

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("update banner on a phone (#296)", () => {
  it("puts the message above the actions instead of beside them", async () => {
    renderWithClient(<UpdateBanner />, clientWithUpdate());
    const banner = await screen.findByTestId("update-banner");
    // In one row, the four actions left the message a 37 px column at 390 px: one word per line.
    expect(stacksOnPhones(banner)).toBe(true);
    // The icon and the message share the top row; the actions are not in it.
    const iconRow = banner.querySelector("svg")?.parentElement;
    expect(iconRow?.textContent).toContain("CodeDen 0.7.2 is available.");
    expect(iconRow?.contains(screen.getByRole("button", { name: "Update now" }))).toBe(false);
  });

  it("keeps Update now primary, the other actions text buttons and × in the corner", async () => {
    renderWithClient(<UpdateBanner />, clientWithUpdate());
    await screen.findByTestId("update-banner");
    expect(screen.getByRole("button", { name: "Update now" }).dataset.variant).toBe("default");
    for (const name of ["What's new", "Later"]) {
      expect(screen.getByRole("button", { name }).dataset.variant).toBe("ghost");
    }
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    // Absolutely placed in the top-right corner on phones; back in the row when there is room.
    expect(narrowThenWide(dismiss, "absolute", "static")).toBe(true);
  });
});

describe("Settings > About on a phone (#296)", () => {
  it("puts the logo above the text and wraps the update buttons together", async () => {
    renderWithClient(<SettingsPage section="about" />, clientWithUpdate(), { withRouter: true });
    const update = await screen.findByRole("button", { name: "Update now" });
    const about = screen.getByRole("heading", { name: "About" }).closest("section");
    // The logo had a column of its own beside the text, which squeezed the text on a phone.
    expect(stacksOnPhones(about?.querySelector("svg")?.parentElement)).toBe(true);
    // "Check now" wrapped to a line of its own, indented by its padding: the buttons wrap as one
    // group, which starts with the filled "Update now" in line with the text.
    const check = screen.getByRole("button", { name: /Check now/ });
    expect(update.parentElement).toBe(check.parentElement);
    expect(update.parentElement?.textContent).not.toContain("Version 0.7.2 is available.");
  });
});
