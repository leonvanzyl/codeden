import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "@/components/composer/model-picker/logic";
import {
  ModelPicker,
  type ModelPickerProps,
} from "@/components/composer/model-picker/model-picker";
import { createMockClient } from "@/lib/api/mock";
import { providers } from "@/lib/api/mock/fixtures/world";
import { snapshotKey } from "@/lib/queries";
import { renderWithClient } from "./utils";

function Harness({
  initial,
  onPick,
  ...rest
}: Partial<ModelPickerProps> & {
  initial: ModelChoice | null;
  onPick?: (v: ModelChoice) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ModelPicker
      providers={providers}
      value={value}
      onChange={(v) => {
        onPick?.(v);
        setValue(v);
      }}
      {...rest}
    />
  );
}

async function setup(props: Parameters<typeof Harness>[0], client = createMockClient()) {
  const onPick = vi.fn();
  const { queryClient } = renderWithClient(<Harness onPick={onPick} {...props} />, client, {
    withRouter: true,
  });
  const trigger = await screen.findByRole("button", { name: /^Provider and model/ });
  // Favourites live in the snapshot's settings.
  await waitFor(() => expect(queryClient.getQueryData(snapshotKey)).toBeTruthy());
  return { onPick, trigger, client };
}

async function openPicker(trigger: HTMLElement) {
  fireEvent.click(trigger);
  return screen.findByTestId("model-picker");
}

const optionName = (name: string) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`);
const option = (name: string) => screen.getByRole("option", { name: optionName(name) });

describe("ModelPicker", () => {
  it("names the provider, model and effort on one trigger", async () => {
    const { trigger } = await setup({
      initial: { provider: "claude", model: "opus", effort: null },
    });
    expect(trigger.getAttribute("aria-label")).toBe(
      "Provider and model: Claude Code Opus, High effort",
    );
    expect(trigger.textContent).toContain("Opus");
    expect(trigger.textContent).toContain("High");
  });

  it("picks a model, clamps the effort and moves focus to that model's levels", async () => {
    const { trigger, onPick } = await setup({
      initial: { provider: "claude", model: "opus", effort: "max" },
    });
    const picker = await openPicker(trigger);
    expect(document.activeElement).toBe(within(picker).getByRole("combobox"));
    fireEvent.click(option("Sonnet"));
    // Sonnet has no Max, so its default (Medium) is used.
    expect(onPick).toHaveBeenLastCalledWith({
      provider: "claude",
      model: "sonnet",
      effort: "medium",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Medium" })),
    );
    expect(
      within(screen.getByRole("radiogroup"))
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Low", "Medium", "High"]);
    fireEvent.click(screen.getByRole("radio", { name: /High/ }));
    expect(onPick).toHaveBeenLastCalledWith({
      provider: "claude",
      model: "sonnet",
      effort: "high",
    });
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
    expect(trigger.getAttribute("aria-label")).toContain("Sonnet, High effort");
  });

  it("closes at once for a model without effort levels and drops the effort", async () => {
    const { trigger, onPick } = await setup({
      initial: { provider: "claude", model: "opus", effort: "high" },
    });
    await openPicker(trigger);
    fireEvent.click(option("Haiku"));
    expect(onPick).toHaveBeenLastCalledWith({ provider: "claude", model: "haiku", effort: null });
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
    expect(trigger.getAttribute("aria-label")).not.toContain("effort");
  });

  it("works from the keyboard: arrows and Enter pick, Left goes back to search", async () => {
    const { trigger, onPick } = await setup({
      initial: { provider: "claude", model: "opus", effort: "xhigh" },
    });
    const picker = await openPicker(trigger);
    const search = within(picker).getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    // Sonnet has no Extra high, so its default (Medium) is used.
    expect(onPick).toHaveBeenLastCalledWith({
      provider: "claude",
      model: "sonnet",
      effort: "medium",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Medium" })),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(search);
  });

  it("shows other providers locked when the provider is fixed", async () => {
    const { trigger, onPick } = await setup({
      initial: { provider: "codex", model: "gpt-6-nova", effort: null },
      lockedProvider: "codex",
    });
    const picker = await openPicker(trigger);
    const claude = within(picker).getByRole("button", { name: /Claude Code can't be used/ });
    expect(claude.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(claude);
    expect(within(picker).queryByRole("option", { name: optionName("Opus") })).toBeNull();
    expect(option("gpt-6-nova")).toBeTruthy();
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "opus" } });
    expect(await within(picker).findByText(/No models match/)).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers to continue in a new session on another provider, when a handoff can run", async () => {
    const onHandoff = vi.fn();
    const { trigger, onPick } = await setup({
      initial: { provider: "codex", model: "gpt-6-nova", effort: null },
      lockedProvider: "codex",
      handoff: { blocked: null, onHandoff },
    });
    const picker = await openPicker(trigger);
    const claude = within(picker).getByRole("button", {
      name: "Continue in a new Claude Code session",
    });
    expect(claude.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(claude);
    expect(onHandoff).toHaveBeenCalledWith("claude");
    expect(onPick).not.toHaveBeenCalled();
    // The picker closes for the handoff dialog.
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
  });

  it("reaches a handoff tile from the keyboard without selecting it", async () => {
    const onHandoff = vi.fn();
    const { trigger } = await setup({
      initial: { provider: "codex", model: "gpt-6-nova", effort: null },
      lockedProvider: "codex",
      handoff: { blocked: null, onHandoff },
    });
    const picker = await openPicker(trigger);
    const rail = within(picker).getByRole("toolbar", { name: "Providers" });
    const codex = within(rail).getByRole("button", { name: /^Codex/ });
    codex.focus();
    // Claude Code is above Codex in the rail: Up stops on its handoff tile.
    fireEvent.keyDown(codex, { key: "ArrowUp" });
    const claude = within(rail).getByRole("button", {
      name: "Continue in a new Claude Code session",
    });
    expect(document.activeElement).toBe(claude);
    // Still on Codex's models: the tile offers the handoff, it isn't a tab.
    expect(option("gpt-6-nova")).toBeTruthy();
    // Down from it goes back to Codex.
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    expect(document.activeElement).toBe(codex);
    // Enter or Space on a focused button clicks it.
    fireEvent.click(claude);
    expect(onHandoff).toHaveBeenCalledWith("claude");
  });

  it("says why a handoff can't run yet, and keeps the tile disabled", async () => {
    const onHandoff = vi.fn();
    const { trigger } = await setup({
      initial: { provider: "codex", model: "gpt-6-nova", effort: null },
      lockedProvider: "codex",
      handoff: { blocked: "Wait for the running turn to finish", onHandoff },
    });
    const picker = await openPicker(trigger);
    const claude = within(picker).getByRole("button", {
      name: "Continue in a new Claude Code session. Not available now: wait for the running turn to finish.",
    });
    expect(claude.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(claude);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it("marks providers that aren't signed in and explains how to fix them", async () => {
    const { trigger } = await setup({
      initial: { provider: "claude", model: "opus", effort: null },
    });
    const picker = await openPicker(trigger);
    const codex = await within(picker).findByRole("button", { name: /^Codex: Not signed in/ });
    fireEvent.click(codex);
    expect(within(picker).getByText(/codex login/)).toBeTruthy();
    expect(within(picker).getByRole("button", { name: /Open setup/ })).toBeTruthy();
    // Models stay pickable: detection can lag behind a fresh login.
    expect(option("gpt-6.1-sol")).toBeTruthy();
  });

  it("searches every provider and hides the rail while searching", async () => {
    const { trigger } = await setup({
      initial: { provider: "claude", model: "opus", effort: null },
    });
    const picker = await openPicker(trigger);
    expect(within(picker).getByRole("toolbar", { name: "Providers" })).toBeTruthy();
    // "gpt mini", not "mini": Gemini's names contain "mini" too.
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "gpt mini" } });
    await waitFor(() =>
      expect(within(picker).queryByRole("toolbar", { name: "Providers" })).toBeNull(),
    );
    const names = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names.every((n) => n?.includes("-mini"))).toBe(true);
    expect(names.length).toBe(3);
  });

  it("switches provider with Ctrl+Shift+Down", async () => {
    const { trigger } = await setup({
      initial: { provider: "claude", model: "opus", effort: null },
    });
    const picker = await openPicker(trigger);
    expect(option("Opus")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(within(picker).getByRole("combobox"), {
        key: "ArrowDown",
        ctrlKey: true,
        shiftKey: true,
      });
    });
    expect(
      await within(picker).findByRole("option", { name: optionName("gpt-6.1-sol") }),
    ).toBeTruthy();
  });

  it('shows "default" and null as the provider\'s default model, checked in the list', async () => {
    for (const model of ["default", null]) {
      const { trigger, onPick } = await setup({
        initial: { provider: "codex", model, effort: null },
      });
      expect(trigger.getAttribute("aria-label")).toBe(
        "Provider and model: Codex Default (gpt-6.1-sol), Medium effort",
      );
      expect(trigger.textContent).toContain("Default (gpt-6.1-sol)");
      await openPicker(trigger);
      expect(option("gpt-6.1-sol").getAttribute("data-checked")).toBe("true");
      // Picking the checked row keeps following the default rather than pinning it.
      fireEvent.click(option("gpt-6.1-sol"));
      expect(onPick).toHaveBeenLastCalledWith({ provider: "codex", model, effort: null });
      cleanup();
    }
  });

  it('names the provider when it only lists its fallback "Default"', async () => {
    const fallback = providers.map((p) =>
      p.id === "codex"
        ? { ...p, models: [{ id: "default", label: "Default", efforts: [], isDefault: true }] }
        : p,
    );
    const { trigger } = await setup({
      initial: { provider: "codex", model: null, effort: null },
      providers: fallback,
    });
    expect(trigger.textContent).toContain("Codex · Default");
    await openPicker(trigger);
    expect(option("Default").getAttribute("data-checked")).toBe("true");
  });

  it("shows a placeholder and footer choices, and can hide effort", async () => {
    const onAuto = vi.fn();
    const { trigger } = await setup({
      initial: null,
      placeholder: "Auto",
      effort: false,
      footer: (close) => (
        <button
          type="button"
          onClick={() => {
            onAuto();
            close();
          }}
        >
          Use Auto
        </button>
      ),
    });
    expect(trigger.getAttribute("aria-label")).toBe("Provider and model: Auto");
    const picker = await openPicker(trigger);
    expect(within(picker).queryByRole("radiogroup")).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Use Auto" }));
    expect(onAuto).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
  });
});

describe("ModelPicker shortcut", () => {
  it("opens and closes with Alt+M when it listens for the shortcut", async () => {
    await setup({ initial: { provider: "claude", model: "opus", effort: null }, shortcut: true });
    act(() => {
      fireEvent.keyDown(window, { key: "m", altKey: true });
    });
    expect(await screen.findByTestId("model-picker")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "m", altKey: true });
    });
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
  });
});

describe("ModelPicker favourites", () => {
  it("stars a model, saves it to settings and lists it under Favourites", async () => {
    const client = createMockClient();
    const save = vi.spyOn(client, "updateSettings");
    const { trigger } = await setup(
      { initial: { provider: "claude", model: "opus", effort: null } },
      client,
    );
    const picker = await openPicker(trigger);
    const star = within(picker).getByRole("button", { name: "Add Sonnet to favourites" });
    fireEvent.click(star);
    // Starring doesn't pick the model.
    expect(
      await within(picker).findByRole("button", { name: "Remove Sonnet from favourites" }),
    ).toBeTruthy();
    expect(save).toHaveBeenCalledWith({
      models: { favorites: [{ provider: "claude", model: "sonnet" }] },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Favourites" }));
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("Sonnet")]);
    expect(trigger.getAttribute("aria-label")).toContain("Opus");
  });

  it("opens on Favourites and leaves out models a provider no longer lists", async () => {
    const client = createMockClient();
    await client.updateSettings({
      models: {
        favorites: [
          { provider: "codex", model: "gpt-6-nova" },
          { provider: "codex", model: "gpt-4-retired" },
          { provider: "claude", model: "opus" },
        ],
      },
    });
    const { trigger } = await setup(
      { initial: { provider: "claude", model: "opus", effort: null } },
      client,
    );
    const picker = await openPicker(trigger);
    expect(
      within(picker).getByRole("button", { name: "Favourites" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const names = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("gpt-6-nova");
    expect(names[1]).toContain("Opus");
  });

  it("shows only the fixed provider's favourites in a running session", async () => {
    const client = createMockClient();
    await client.updateSettings({
      models: {
        favorites: [
          { provider: "claude", model: "opus" },
          { provider: "codex", model: "gpt-6-nova" },
        ],
      },
    });
    const { trigger } = await setup(
      { initial: { provider: "codex", model: "default", effort: null }, lockedProvider: "codex" },
      client,
    );
    const picker = await openPicker(trigger);
    // A fixed provider opens on its own tab.
    expect(option("gpt-6.1-sol")).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "Favourites" }));
    const names = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("gpt-6-nova");
  });

  it("explains an empty Favourites tab", async () => {
    const { trigger } = await setup({
      initial: { provider: "claude", model: "opus", effort: null },
    });
    const picker = await openPicker(trigger);
    fireEvent.click(within(picker).getByRole("button", { name: "Favourites" }));
    expect(within(picker).getByText(/No favourites yet/)).toBeTruthy();
  });
});
