import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupChecklist } from "@/components/setup/checklist";
import { createMockClient } from "@/lib/api/mock";
import { platform } from "@/lib/platform";
import { SetupPage } from "@/routes/setup";
import { renderWithClient } from "./utils";

/** Opens step 2 ("Voice & notifications") of first-run setup. */
async function openVoiceStep() {
  const client = createMockClient();
  // Claude Code support is already installed, so Continue goes straight to step 2.
  vi.spyOn(client, "getClaudeSdkStatus").mockResolvedValue({
    state: "ready",
    version: "0.3.318",
    source: "deps",
    location: "~/.codeden/deps",
    progress: null,
    error: null,
  });
  renderWithClient(<SetupPage />, client, { withRouter: true });
  const next = await screen.findByRole("button", { name: /^Continue/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
  await screen.findByText("Read final messages aloud");
}

afterEach(() => vi.restoreAllMocks());

describe("first-run setup on a phone", () => {
  it("shows a failed check's whole reason instead of cutting it off", async () => {
    renderWithClient(<SetupChecklist />);
    const reason = await screen.findByText("Installed (0.58.0) but not signed in");
    // On a 390 px screen a single-line, truncated reason shows as "Installe…".
    expect(reason.closest("[data-check]")?.getAttribute("data-check")).toBe("codex");
    expect(reason.className).not.toMatch(/\btruncate\b/);
  });

  it("names the read-aloud switch", async () => {
    await openVoiceStep();
    expect(screen.getByRole("switch", { name: "Read final messages aloud" })).toBeTruthy();
  });

  it("says how to allow notifications again once the browser blocked them", async () => {
    vi.spyOn(platform, "notificationPermission").mockReturnValue("denied");
    await openVoiceStep();
    // It used to show only a disabled "Blocked" button: a dead end.
    expect(screen.getByText(/site settings/i)).toBeTruthy();
    const recheck = screen.getByRole("button", { name: /check again/i });
    expect((recheck as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Blocked" })).toBeNull();
  });

  it("doesn't send a phone on plain http to site settings it can't change", async () => {
    // A phone on the network reaches CodeDen over http (§13): no notifications there at all.
    vi.spyOn(platform, "notificationPermission").mockReturnValue("denied");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      await openVoiceStep();
      expect(screen.getByText(/only allow notifications on secure pages/i)).toBeTruthy();
      expect(screen.queryByText(/site settings/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /check again/i })).toBeNull();
    } finally {
      Reflect.deleteProperty(window, "isSecureContext");
    }
  });
});
