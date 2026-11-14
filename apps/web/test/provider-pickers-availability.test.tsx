import type { Project, Session } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { HandoffDialog } from "@/components/thread/handoff-dialog";
import { createMockClient } from "@/lib/api/mock";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { projects } from "@/lib/api/mock/fixtures/world";
import { useUiStore } from "@/stores/ui";
import { renderWithClient } from "./utils";

/**
 * #255: the provider pickers outside the model picker don't say which providers can run. In the
 * mock world Codex is installed but not signed in (`fixtures/ops.ts`), and every other agent
 * provider is ready.
 */

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

/** A finished Claude agent session with work to hand off. */
const claudeSession = (() => {
  const found = fixtureSessions.find(
    (s) =>
      s.role === "agent" &&
      s.provider === "claude" &&
      s.status === "completed" &&
      s.branch &&
      s.rootThreadId,
  );
  if (!found) throw new Error("no finished Claude fixture session");
  return found as Session;
})();

const storefront = projects.find((p) => p.id === "p-storefront") as Project;

/** Wait until the mock's setup checks have loaded, so availability is known. */
async function setupLoaded(client: ReturnType<typeof createMockClient>) {
  const status = await client.getSetupStatus();
  expect(status.checks.find((c) => c.id === "codex")?.loggedIn).toBe(false);
}

describe("hand-off dialog and provider availability (#255)", () => {
  it("doesn't pre-select a provider that isn't signed in", async () => {
    const client = createMockClient();
    await setupLoaded(client);
    renderWithClient(<HandoffDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setHandoff({ sessionId: claudeSession.id, provider: null }));
    const dialog = await screen.findByTestId("handoff-dialog");

    // Give the setup checks time to arrive; the default must then be a provider that can run.
    await waitFor(
      () => {
        const submit = within(dialog).getByRole("button", { name: /^Continue in new/ });
        expect(submit.textContent).not.toMatch(/Codex/);
      },
      { timeout: 2000 },
    );
  });

  it("says a signed-out target can't run and doesn't hand off to it", async () => {
    const client = createMockClient();
    const handoff = vi.spyOn(client, "handoffSession");
    renderWithClient(<HandoffDialog />, client, { withRouter: true });
    act(() => useUiStore.getState().setHandoff({ sessionId: claudeSession.id, provider: "codex" }));
    const dialog = await screen.findByTestId("handoff-dialog");

    await waitFor(() => expect(within(dialog).getByText(/not signed in/i)).toBeTruthy(), {
      timeout: 2000,
    });
    // The fix is named, and the check can be run again.
    expect(within(dialog).getByText("codex login")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Check again" })).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: /^Continue in new Codex/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("shows in the dialog that the brief is being written", async () => {
    const client = createMockClient();
    // The brief takes a while: the request stays open for the whole test.
    vi.spyOn(client, "handoffSession").mockImplementation(() => new Promise(() => {}));
    renderWithClient(<HandoffDialog />, client, { withRouter: true });
    act(() =>
      useUiStore.getState().setHandoff({ sessionId: claudeSession.id, provider: "opencode" }),
    );
    const dialog = await screen.findByTestId("handoff-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Continue in new/ }));

    await waitFor(() =>
      expect(within(dialog).getByText(/Writing the hand-?off brief/)).toBeTruthy(),
    );
  });
});

describe("factory builder and reviewer providers and availability (#255)", () => {
  it("marks providers that aren't signed in, and says so when one is chosen", async () => {
    const client = createMockClient();
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const reviewer = (await screen.findByLabelText("Reviewer provider")) as HTMLSelectElement;
    await waitFor(
      () => {
        const codex = within(reviewer).getByRole("option", { name: /Codex/ });
        expect(codex.textContent).toMatch(/not signed in/i);
      },
      { timeout: 2000 },
    );
    const builder = screen.getByLabelText("Builder provider") as HTMLSelectElement;
    expect(within(builder).getByRole("option", { name: /Codex/ }).textContent).toMatch(
      /not signed in/i,
    );
    // Ready providers are listed by name alone.
    expect(within(reviewer).getByRole("option", { name: "OpenCode" })).toBeTruthy();

    fireEvent.change(reviewer, { target: { value: "codex" } });
    expect(screen.getByText(/codex login/)).toBeTruthy();
    // It says what happens until Codex can run: the fallback chosen below.
    expect(
      screen.getByText(/Until it can run, reviews run on the builder's provider/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("When the reviewer's provider is unavailable"), {
      target: { value: "wait" },
    });
    expect(screen.getByText(/Until it can run, reviews wait/)).toBeTruthy();
  });
});
