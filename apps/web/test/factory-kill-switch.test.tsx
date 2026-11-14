import { FactoryLimits, FactoryStatus, type Project } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ViewHeader } from "@/components/factory-view/view-header";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/**
 * #286: the kill switch is a choice: "Finish current work, then stop" (a drain, offered first)
 * or "Stop now". While the factory drains, the header says how many items are in flight and
 * offers Resume and Stop now.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const at = "2026-11-14T08:00:00.000Z";
const project = { id: "p-app", name: "app" } as Project;
const pixel = { available: false, on: false, set: () => {} };

const status = (patch: Partial<FactoryStatus> = {}): FactoryStatus =>
  FactoryStatus.parse({
    projectId: "p-app",
    mode: "software_factory",
    experimental: true,
    loopState: "building",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 10 } }),
    tuning: {},
    spendToday: { usd: 1, tokens: 1000 },
    mergesToday: 0,
    consecutiveFailures: 0,
    activeSessions: 2,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: at,
    ...patch,
  });

function renderHeader(f: FactoryStatus) {
  const client = createMockClient();
  const killSwitch = vi.fn(async () => ({
    on: false,
    stoppedSessions: [],
    draining: true,
    inFlight: 2,
  }));
  client.factory.killSwitch = killSwitch;
  renderWithClient(
    <ViewHeader project={project} f={f} needsPerson={0} failed={0} pixel={pixel} />,
    client,
    { withRouter: true },
  );
  return killSwitch;
}

describe("the kill switch's two ways to stop (#286)", () => {
  it("offers finishing current work first, then Stop now, and starts a drain", async () => {
    const killSwitch = renderHeader(status());
    const trigger = await screen.findByRole("button", { name: /Kill switch/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Finish current work, then stop/),
      expect.stringMatching(/^Stop now/),
    ]);
    fireEvent.click(items[0] as HTMLElement);
    expect(await screen.findByText("Finish current work, then stop?")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Drain time limit" }).textContent).toBe(
      "No time limit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Finish, then stop" }));
    await waitFor(() =>
      expect(killSwitch).toHaveBeenCalledWith({ projectId: "p-app" }, true, {
        mode: "drain",
        drainLimitMin: null,
      }),
    );
  });

  it("shows the draining count, with Resume and Stop now", async () => {
    const killSwitch = renderHeader(
      status({
        loopState: "draining",
        drain: { since: at, inFlight: 2, total: 3, deadline: null },
      }),
    );
    expect((await screen.findByTestId("factory-drain")).textContent).toContain(
      "Draining: 2 items in flight",
    );
    expect(screen.queryByRole("button", { name: /Kill switch/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Stop now/ })).toBeTruthy();
    fireEvent.click(screen.getByTestId("factory-drain-resume"));
    await waitFor(() =>
      expect(killSwitch).toHaveBeenCalledWith({ projectId: "p-app" }, false, {
        mode: undefined,
        drainLimitMin: undefined,
      }),
    );
  });
});
