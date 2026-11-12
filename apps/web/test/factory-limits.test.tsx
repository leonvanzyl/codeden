import type { Project } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { createMockClient } from "@/lib/api/mock";
import { projects } from "@/lib/api/mock/fixtures/world";
import { renderWithClient } from "./utils";

const storefront = projects.find((p) => p.id === "p-storefront") as Project;

describe("factory settings in the autonomy dialog", () => {
  it("shows the size limits, saves an empty box as no limit and keeps valid trusted authors", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const lines = (await screen.findByLabelText("Largest change (lines)")) as HTMLInputElement;
    await waitFor(() => expect(lines.value).toBe("5000"));
    const files = screen.getByLabelText("Most files changed") as HTMLInputElement;
    expect(files.value).toBe("");
    expect(files.placeholder).toBe("No limit");
    expect(screen.getByText(/Lockfiles and generated files don't count/)).toBeTruthy();

    fireEvent.change(lines, { target: { value: "" } });
    fireEvent.change(files, { target: { value: "120" } });
    const authors = screen.getByLabelText("Trusted authors") as HTMLTextAreaElement;
    fireEvent.change(authors, { target: { value: "@octocat\n-not-a-login!\nmy-teammate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    expect(setMode.mock.calls[0]?.[1]).toMatchObject({
      mode: "dark_factory",
      limits: { autoMerge: false, trustedAuthors: ["octocat", "my-teammate"] },
      tuning: { maxChangedLines: null, maxChangedFiles: 120, requireCi: true },
    });
    success.mockRestore();
  });

  it("edits the scout's backlog threshold and the other knobs without resetting the rest", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const backlog = (await screen.findByLabelText("Review when fewer than")) as HTMLInputElement;
    await waitFor(() => expect(backlog.value).toBe("2"));
    expect(screen.getByText("issues wait for an agent.")).toBeTruthy();
    fireEvent.change(backlog, { target: { value: "0" } });
    expect(screen.getByText("Off: only Run scout now starts a round.")).toBeTruthy();
    // A negative number isn't a threshold: the box falls back to 0.
    fireEvent.change(backlog, { target: { value: "-3" } });
    expect(backlog.value).toBe("0");
    fireEvent.change(screen.getByLabelText("Revise rounds"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Watch main CI (minutes)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    const tuning = setMode.mock.calls[0]?.[1].tuning;
    expect(tuning).toMatchObject({
      minBacklog: 0,
      maxFixAttempts: 4,
      watchTimeoutMin: 45,
      // Unchanged knobs keep their saved values.
      discoveryIntervalMin: 360,
      maxIssuesPerRound: 3,
      maxChangedLines: 5000,
      requireCi: true,
    });
    // Knobs the editor doesn't show aren't sent, so the server keeps what it has.
    expect(tuning).not.toHaveProperty("areas");
    expect(tuning).not.toHaveProperty("builderProvider");
    success.mockRestore();
  });
});
