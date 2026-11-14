import type { ProviderInfo, Session, SetupCheck } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerAvailability } from "@/components/composer/model-picker/logic";
import {
  HandoffDialog,
  handoffTargetProblem,
  initialHandoffChoice,
} from "@/components/thread/handoff-dialog";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { providers } from "@/lib/api/mock/fixtures/world";
import { handoffBlocked, useHandoffBlocked } from "@/lib/session-actions";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useUiStore } from "@/stores/ui";
import { renderWithClient } from "./utils";

const now = () => new Date().toISOString();

/** Renders `useHandoffBlocked` and reports what it says. */
function BlockedProbe({
  session,
  onBlocked,
}: {
  session: Session;
  onBlocked: (blocked: string | null) => void;
}) {
  onBlocked(useHandoffBlocked(session));
  return <span>probe</span>;
}

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

/** A setup check for a provider; ready unless overridden. */
const setupCheck = (id: string, over: Partial<SetupCheck> = {}): SetupCheck => ({
  // Agent provider ids are setup check ids (matched by `providerAvailability`).
  id: id as SetupCheck["id"],
  label: id,
  state: "ok",
  installed: true,
  version: null,
  executablePath: null,
  loggedIn: true,
  authMethod: null,
  account: null,
  loginExpiresAt: null,
  message: "",
  fix: null,
  durationMs: 1,
  ...over,
});

describe("handing a session off", () => {
  it("is blocked while a turn runs, before it starts, without a branch or without work", () => {
    expect(handoffBlocked(idle, 2)).toBeNull();
    for (const status of ["failed", "stopped", "interrupted", "completed"] as const) {
      expect(handoffBlocked({ ...idle, status }, 2)).toBeNull();
    }
    expect(handoffBlocked({ ...idle, status: "running" }, 2)).toMatch(/running turn/);
    expect(handoffBlocked({ ...idle, status: "waiting" }, 2)).toMatch(/waiting on/);
    expect(handoffBlocked({ ...idle, status: "starting" }, 0)).toMatch(/hasn't started/);
    expect(handoffBlocked({ ...idle, branch: null }, 2)).toMatch(/git branch/);
    // Like the server: no turns yet, even with a thread the provider opened.
    expect(handoffBlocked(idle, 0)).toMatch(/Nothing to hand off/);
    // Without the transcript the turns aren't known here, and the server decides.
    expect(handoffBlocked({ ...idle, rootThreadId: null }, undefined)).toBeNull();
    // Unlike Fork, no conversation of the provider's own is needed.
    expect(handoffBlocked({ ...idle, resumeToken: null }, 2)).toBeNull();
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

  it("starts on another provider that can run, else the session's own (#255)", () => {
    const claude = { ...idle, provider: "claude", model: "opus", effort: "high" as const };
    const [first, second] = providers.filter((p) => p.id !== "claude");
    if (!first || !second) throw new Error("need two other providers");
    const signedOut = setupCheck(first.id, { state: "missing", loggedIn: false });
    // The first other provider isn't signed in: the next one that can run is chosen.
    expect(initialHandoffChoice(claude, providers, null, [signedOut]).provider).toBe(second.id);
    // Asked for explicitly, it is kept (the dialog then says why it can't run).
    expect(initialHandoffChoice(claude, providers, first.id, [signedOut]).provider).toBe(first.id);
    // No other provider can run: the session's own, with its model and effort.
    const none = providers
      .filter((p) => p.id !== "claude")
      .map((p) => setupCheck(p.id, { state: "missing", installed: false }));
    expect(initialHandoffChoice(claude, providers, null, none)).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
    });
  });

  it("refuses a provider that can't start, with the reason", () => {
    const target = provider("codex");
    const signedOut = providerAvailability("codex", [
      setupCheck("codex", { state: "missing", loggedIn: false }),
    ]);
    expect(handoffTargetProblem(idle, target, signedOut)).toBe(
      "Codex can't start sessions: not signed in.",
    );
    expect(handoffTargetProblem(idle, target, providerAvailability("codex", []))).toBeNull();
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
    // Another provider that is signed in (the mock's Codex isn't).
    const other = providers.find(
      (p) => p.id !== finished.provider && p.id !== "codex",
    ) as ProviderInfo;
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

  it("counts the turns of the loaded transcript, as the server does", async () => {
    const client = createMockClient();
    const handoff = vi.spyOn(client, "handoffSession");
    // A fork that was just made: its provider opened a thread, but no turn has run.
    const fresh: Session = { ...idle, id: "s-fresh-fork", rootThreadId: "t-fresh" };
    act(() =>
      useTranscriptsStore.getState().load({
        seq: 1,
        session: fresh,
        threads: [
          {
            id: "t-fresh",
            sessionId: fresh.id,
            parentThreadId: null,
            parentItemId: null,
            title: null,
            agentType: null,
            createdAt: fresh.createdAt,
          },
        ],
        turns: [],
        items: [],
      }),
    );
    let blocked: string | null | undefined;
    renderWithClient(
      <BlockedProbe
        session={fresh}
        onBlocked={(b) => {
          blocked = b;
        }}
      />,
      client,
    );
    await screen.findByText("probe");
    expect(blocked).toBe("Nothing to hand off yet");

    // Once a turn starts, it counts.
    act(() =>
      useTranscriptsStore
        .getState()
        .apply(fresh.id, { type: "turn.started", threadId: "t-fresh", turnId: "u1" }, 2, now()),
    );
    expect(blocked).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
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
