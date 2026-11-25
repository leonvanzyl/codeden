import { isActiveSession, type TechDebtFinding } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TechDebtPanel } from "@/components/project/tech-debt-panel";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { renderWithClient } from "./utils";

it("makes a stopped session's finding selectable without offering retry during the run", async () => {
  const client = createMockClient();
  const { sessions } = await client.getSnapshot();
  const session = sessions.find(isActiveSession);
  if (!session?.projectId) throw new Error("The mock needs an active project session");
  const projectId = session.projectId;
  const finding: TechDebtFinding = {
    id: "finding",
    source: null,
    location: "src/build.ts:12",
    text: "Use the shared helper.",
    date: "2026-11-23T00:00:00.000Z",
    receipt: null,
    pr: null,
    status: "in_progress",
    sessionId: session.id,
    reason: null,
  };
  const view = { projectId, issue: null, imported: false, findings: [finding] };
  const subscribe = vi.spyOn(client, "subscribe");
  const list = vi.spyOn(client.techDebt, "list").mockResolvedValue(view);
  const update = vi.spyOn(client.techDebt, "act").mockResolvedValue(view);
  const { queryClient } = renderWithClient(<TechDebtPanel projectId={projectId} />, client, {
    withRouter: true,
  });
  const stop = startRealtime(client, queryClient);
  try {
    await screen.findByText("In progress");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry fix" })).toBeNull();
    await waitFor(() => expect(subscribe).toHaveBeenCalled());

    list.mockResolvedValue({
      ...view,
      findings: [{ ...finding, status: "open", sessionId: null }],
    });
    await act(() => client.stopSession(session.id));
    const checkbox = await screen.findByRole("checkbox", {
      name: `Select finding at ${finding.location}`,
    });
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Fix session" })).toBeNull();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Fix selected (1)" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(projectId, { action: "fix", ids: [finding.id] }),
    );
  } finally {
    stop();
  }
});
