import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { startRealtime } from "@/lib/realtime";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * #275: Retry on a failed run re-ran the same dead provider and said "Couldn't update the item";
 * stale failed runs piled up with no way to clear them. In the mock world Codex is installed but
 * not signed in (`fixtures/ops.ts`): `ib-failed` is a failed run of a Codex session,
 * `ib-failed-a11y` one of a Claude session that failed twice.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

afterEach(() => vi.clearAllMocks());

/** The rendered inbox entry of an item. */
async function entry(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.getElementById(`inbox-item-${id}`);
    if (!el) throw new Error(`no entry ${id}`);
    return el;
  });
}

describe("failed runs in the inbox (#275)", () => {
  it("turns Retry off with the reason and the fix while the session's provider can't run", async () => {
    const client = createMockClient();
    const retry = vi.spyOn(client, "retryInbox");
    renderWithClient(<InboxPage />, client, { withRouter: true });
    const codex = await entry("ib-failed");
    // Once the setup checks are in, Retry knows it would only fail again.
    await waitFor(() =>
      expect(within(codex).getByRole("button", { name: /Retry/ })).toHaveProperty("disabled", true),
    );
    const why = within(codex).getByTestId("retry-blocked").textContent;
    expect(why).toMatch(/Codex is not signed in/);
    expect(why).toMatch(/codex login/);
    expect(
      within(codex).getByRole("button", { name: /Continue on another provider/ }),
    ).toBeTruthy();
    fireEvent.click(within(codex).getByRole("button", { name: /Retry/ }));
    expect(retry).not.toHaveBeenCalled();

    // A run whose provider can run keeps Retry, and shows how often it failed.
    const claude = await entry("ib-failed-a11y");
    expect(within(claude).getByRole("button", { name: /Retry/ })).toHaveProperty("disabled", false);
    expect(within(claude).queryByTestId("retry-blocked")).toBeNull();
    expect(within(claude).getByText("Failed 2 times")).toBeTruthy();
  });

  it("says why when a retry fails again", async () => {
    const client = createMockClient();
    vi.spyOn(client, "retryInbox").mockRejectedValueOnce(
      new Error("Could not open the session: The agent process crashed"),
    );
    renderWithClient(<InboxPage />, client, { withRouter: true });
    const claude = await entry("ib-failed-a11y");
    fireEvent.click(within(claude).getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Retry failed", {
        description: "Could not open the session: The agent process crashed",
      }),
    );
    expect(client.retryInbox).toHaveBeenCalledWith("ib-failed-a11y");
  });

  it("dismisses every failed run at once", async () => {
    const client = createMockClient();
    const { queryClient } = renderWithClient(<InboxPage />, client, { withRouter: true });
    const stop = startRealtime(client, queryClient);
    try {
      await screen.findByText("Failed runs · 2");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
      await waitFor(() => expect(screen.queryByText(/Failed runs/)).toBeNull());
      expect(toast.success).toHaveBeenCalledWith("Dismissed 2 failed runs");
      const snapshot = await client.getSnapshot();
      expect(snapshot.inbox.filter((i) => i.kind === "run_failed").map((i) => i.status)).toEqual([
        "dismissed",
        "dismissed",
      ]);
      // Other items stay.
      expect(
        screen.getByText("Security audit (Billing API) flagged 2 medium findings"),
      ).toBeTruthy();
    } finally {
      stop();
    }
  });
});
