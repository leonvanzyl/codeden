import type { AutomationRun, AutomationRunStatus, RunAutomationResponse } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAutomationActions } from "@/components/automations/use-automation-actions";
import { createMockClient } from "@/lib/api/mock";
import { runResultToast } from "@/lib/automations";
import { NewAutomationPage } from "@/routes/automation-new";
import { renderWithClient } from "./utils";

/**
 * Issue #606: a launch that throws is recorded as a failed run and answered with `started`.
 * Run now and Save and run now show that as a failure with the run's error, never "Run started".
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const run = (status: AutomationRunStatus, error: string | null = null): AutomationRun => ({
  id: "run-1",
  automationId: "a-1",
  projectId: "p-storefront",
  status,
  triggeredBy: "manual",
  startedBy: { kind: "user" },
  purpose: "Nightly notes",
  workKey: "automation:nightly-notes",
  scope: { projectId: "p-storefront" },
  progress: null,
  skipReason: status === "skipped" ? "concurrency" : null,
  sessionId: null,
  issueNumber: null,
  startedAt: "2026-11-12T08:00:00.000Z",
  finishedAt: status === "failed" ? "2026-11-12T08:00:01.000Z" : null,
  error: error ? { message: error } : null,
});

const LAUNCH_ERROR = "Provider claude is not installed";
const failedLaunch: RunAutomationResponse = {
  status: "started",
  run: run("failed", LAUNCH_ERROR),
  sessionId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runResultToast", () => {
  it("shows a failed launch as an error with the run's message", () => {
    expect(runResultToast(failedLaunch)).toEqual({
      kind: "error",
      title: "Run failed",
      description: LAUNCH_ERROR,
      sessionId: null,
    });
  });

  it("falls back to a plain message when the failed run has no error", () => {
    expect(runResultToast({ status: "started", run: run("failed"), sessionId: "s-1" })).toEqual({
      kind: "error",
      title: "Run failed",
      description: "The automation couldn't start.",
      sessionId: "s-1",
    });
  });

  it("keeps the messages of started, queued, skipped and joined results", () => {
    expect(runResultToast({ status: "started", run: run("running"), sessionId: "s-1" })).toEqual({
      kind: "success",
      title: "Run started",
      sessionId: "s-1",
    });
    expect(runResultToast({ status: "started", run: run("completed"), sessionId: "s-pm" })).toEqual(
      { kind: "success", title: "Run started", sessionId: "s-pm" },
    );
    expect(
      runResultToast({ status: "queued", run: run("queued"), sessionId: "s-2", behind: ["s-0"] }),
    ).toEqual({ kind: "success", title: "Queued behind running work", sessionId: "s-2" });
    expect(runResultToast({ status: "skipped", run: run("skipped") })).toEqual({
      kind: "success",
      title: "Skipped",
      sessionId: null,
    });
    expect(runResultToast({ status: "joined", sessionId: "s-3" })).toEqual({
      kind: "success",
      title: "Sent to the running session",
      sessionId: "s-3",
    });
  });
});

function RunNow() {
  const { run } = useAutomationActions("p-storefront");
  return (
    <button type="button" onClick={() => run.mutate({ id: "a-1", name: "Nightly notes" })}>
      Run now
    </button>
  );
}

describe("Run now", () => {
  it("shows a failed launch as an error with the run's message, not 'Run started'", async () => {
    const client = createMockClient();
    vi.spyOn(client.automations, "run").mockResolvedValue(failedLaunch);
    renderWithClient(<RunNow />, client, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0]?.[0]).toBe("Run failed");
    expect(toast.error.mock.calls[0]?.[1]).toMatchObject({ description: LAUNCH_ERROR });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("still says 'Run started' with Open session when the run started", async () => {
    const client = createMockClient();
    vi.spyOn(client.automations, "run").mockResolvedValue({
      status: "started",
      run: run("running"),
      sessionId: "s-1",
    });
    renderWithClient(<RunNow />, client, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success.mock.calls[0]?.[0]).toBe("Run started");
    toast.success.mock.calls[0]?.[1]?.action?.onClick();
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s-1" },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("Save and run now", () => {
  it("saves, opens the automation and shows the failed run's error", async () => {
    const client = createMockClient();
    const create = vi.spyOn(client.automations, "create");
    const runNow = vi.spyOn(client.automations, "run").mockResolvedValue(failedLaunch);
    renderWithClient(<NewAutomationPage projectId="p-storefront" sessionId="s-search" />, client, {
      withRouter: true,
    });
    await screen.findAllByDisplayValue("Add product search with filters");
    fireEvent.click(screen.getByRole("button", { name: "Save and run now" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    const saved = await create.mock.results[0]?.value;
    expect(runNow).toHaveBeenCalledWith(saved.automation.id, { projectId: "p-storefront" });
    expect(toast.success.mock.calls.map((c) => c[0])).toEqual([
      "Add product search with filters saved, off",
    ]);
    expect(toast.error.mock.calls[0]?.[0]).toBe("Run failed");
    expect(toast.error.mock.calls[0]?.[1]).toMatchObject({ description: LAUNCH_ERROR });
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/automations/$automationId",
      params: { projectId: "p-storefront", automationId: saved.automation.id },
      replace: true,
    });
  });
});
