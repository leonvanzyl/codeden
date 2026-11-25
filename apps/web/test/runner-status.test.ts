import type { RunnerConnectionStatus } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { runnerStatusText } from "@/lib/runner-status";

const status = (patch: Partial<RunnerConnectionStatus>): RunnerConnectionStatus => ({
  state: "connected",
  runnerId: "r1",
  version: "0.0.0",
  providers: [],
  lastError: null,
  ...patch,
});

describe("runnerStatusText (#14)", () => {
  it("says the runner is starting while the server waits for it", () => {
    const text = runnerStatusText("open", status({ state: "starting" }));
    expect(text).toMatchObject({ tone: "waiting", label: "Starting the runner…" });
    const slow = runnerStatusText(
      "open",
      status({ state: "starting", lastError: "The runner is taking longer than usual to start" }),
    );
    expect(slow.label).toBe("Starting the runner…");
    expect(slow.detail).toContain("taking longer than usual");
  });

  it("shows why a runner that crashed during start-up is not connected", () => {
    const text = runnerStatusText(
      "open",
      status({
        state: "disconnected",
        lastError: "The runner exited during start-up (exit 1). The end of logs/runner.log:\nboom",
      }),
    );
    expect(text.tone).toBe("failed");
    expect(text.label).toBe("Runner disconnected");
    expect(text.detail).toContain("boom");
  });

  it("is Ready when connected and Connecting… without a socket", () => {
    expect(runnerStatusText("open", status({})).label).toBe("Ready");
    expect(runnerStatusText("closed", status({})).label).toBe("Connecting…");
  });

  it("shows when the attached runner stops answering and clears on recovery", () => {
    expect(runnerStatusText("open", status({ responsive: false }))).toMatchObject({
      tone: "failed",
      label: "Runner unresponsive",
    });
    expect(runnerStatusText("open", status({ responsive: true })).label).toBe("Ready");
  });
});
