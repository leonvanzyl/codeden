import type { ProviderInfo, Session } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HandoffDialog,
  handoffTargetProblem,
  initialHandoffChoice,
} from "@/components/thread/handoff-dialog";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { providers } from "@/lib/api/mock/fixtures/world";
import { handoffBlocked } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => "loading-1"),
  }),
);
vi.mock("sonner", () => ({ toast }));

afterEach(() => act(() => useUiStore.getState().setHandoff(null)));

/** A fixture agent session that has done some work and isn't running. */
const finished = (() => {
  const found = fixtureSessions.find(
    (s) => s.role === "agent" && s.status === "completed" && s.branch && s.rootThreadId,
  );
  if (!found) throw new Error("no finished fixture session");
  return found;
})();

const idle: Session = { ...finished, status: "idle", rootThreadId: "t-root" };
const provider = (id: string) => providers.find((p) => p.id === id) as ProviderInfo;

describe("handing a session off", () => {
  it("is blocked while a turn runs, before it starts, without a branch or without work", () => {
    expect(handoffBlocked(idle)).toBeNull();
    for (const status of ["failed", "stopped", "interrupted", "completed"] as const) {
      expect(handoffBlocked({ ...idle, status })).toBeNull();
    }
    expect(handoffBlocked({ ...idle, status: "running" })).toMatch(/running turn/);
    expect(handoffBlocked({ ...idle, status: "waiting" })).toMatch(/waiting on/);
    expect(handoffBlocked({ ...idle, status: "starting" })).toMatch(/hasn't started/);
    expect(handoffBlocked({ ...idle, branch: null })).toMatch(/git branch/);
    expect(handoffBlocked({ ...idle, rootThreadId: null })).toMatch(/Nothing to hand off/);
    // Unlike Fork, no conversation of the provider's own is needed.
    expect(handoffBlocked({ ...idle, resumeToken: null })).toBeNull();
  });

  it("starts on the provider asked for, else another one; the same keeps the model", () => {
    const claude = { ...idle, provider: "claude", model: "opus", effort: "high" as const };
    expect(initialHandoffChoice(claude, providers, "codex")).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
    expect(initialHandoffChoice(claude, providers, null).provider).not.toBe("claude");
    expect(initialHandoffChoice(claude, providers, "claude")).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
    });
    // A provider that isn't listed any more is ignored.
    expect(initialHandoffChoice(claude, providers, "gone").provider).not.toBe("gone");
  });

  it("refuses providers that can't keep the session's permissions", () => {
    const plain = {
      ...provider("claude"),
      displayName: "Plain",
      capabilities: { ...provider("claude").capabilities, readOnly: false, planMode: false },
    };
    expect(handoffTargetProblem(idle, plain)).toBeNull();
    expect(handoffTargetProblem({ ...idle, autonomy: "read_only" }, plain)).toMatch(
      /Plain can't run read-only sessions/,
    );
    expect(handoffTargetProblem({ ...idle, planMode: true }, plain)).toMatch(
      /Plain has no plan mode/,
    );
    expect(handoffTargetProblem({ ...idle, planMode: true }, provider("claude"))).toBeNull();
  });

  it("hands off through the client with the note, then opens the new session", async () => {
    const client = createMockClient();
    const handoff = vi.spyOn(client, "handoffSession");
    const other = providers.find((p) => p.id !== finished.provider) as ProviderInfo;
    renderWithClient(<HandoffDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setHandoff({ sessionId: finished.id, provider: other.id }));

    const dialog = await screen.findByTestId("handoff-dialog");
    expect(within(dialog).getByText("Hand off this session")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/What should it do next/), {
      target: { value: "  Review the approach first.  " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: `Continue in new ${other.displayName} session`,
      }),
    );

    await waitFor(() =>
      expect(handoff).toHaveBeenCalledWith(finished.id, {
        provider: other.id,
        note: "Review the approach first.",
      }),
    );
    expect(toast.loading).toHaveBeenCalledWith("Writing the handoff brief…");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `Continued in a new ${other.displayName} session`,
        expect.objectContaining({ id: "loading-1" }),
      ),
    );
    await waitFor(() => expect(useUiStore.getState().handoff).toBeNull());
    // The new session records where it came from.
    const created = await client.getSnapshot();
    expect(
      created.sessions.find((s) => s.forkedFrom?.sessionId === finished.id)?.forkedFrom,
    ).toEqual({ sessionId: finished.id, checkpoint: null, kind: "handoff" });
  });

  it("says why it can't hand off a running session, and doesn't try", async () => {
    const client = createMockClient();
    const handoff = vi.spyOn(client, "handoffSession");
    const running = fixtureSessions.find((s) => s.role === "agent" && s.status === "running");
    if (!running) throw new Error("no running fixture session");
    renderWithClient(<HandoffDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setHandoff({ sessionId: running.id, provider: null }));
    const dialog = await screen.findByTestId("handoff-dialog");
    expect(within(dialog).getByRole("status").textContent).toMatch(/running turn/);
    const submit = within(dialog).getByRole("button", { name: /^Continue in new/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(handoff).not.toHaveBeenCalled();
  });
});
