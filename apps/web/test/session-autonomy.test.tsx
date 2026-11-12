import type { Session } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appliesFrom, SessionOptions } from "@/components/composer/session-options";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { snapshotKey, useSnapshotData } from "@/lib/queries";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const agent = (over: Partial<Session> = {}): Session =>
  makeSession({
    id: "s-checkout",
    projectId: "p-storefront",
    role: "agent",
    status: "running",
    provider: "claude",
    model: "opus",
    purpose: "Fix flaky checkout e2e test",
    workKey: "issue:142",
    ...over,
  });

/** The session as the app renders it: read from the snapshot, which a PATCH updates. */
function FromSnapshot({ id }: { id: string }) {
  const session = useSnapshotData((s) => s.sessions.find((x) => x.id === id), undefined);
  return session ? <SessionOptions session={session} running /> : null;
}

async function pickAutonomy(label: string) {
  const trigger = screen.getByRole("button", { name: "Permissions" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(label) }));
}

describe("appliesFrom", () => {
  it("says when a change made during a turn takes effect", () => {
    expect(appliesFrom({ autonomy: "full" }, false, true)).toBeUndefined();
    expect(appliesFrom({ autonomy: "full" }, true, true)).toBe("Applies from the next tool call.");
    expect(appliesFrom({ autonomy: "full" }, true, false)).toBe("Applies from the next turn.");
    expect(appliesFrom({ model: "opus" }, true, true)).toBe("Applies from the next turn.");
  });
});

describe("SessionOptions autonomy (§11.2)", () => {
  it("shows the server's level and saves a change with PATCH", async () => {
    const client = createMockClient();
    const updateSession = vi.spyOn(client, "updateSession");
    await client.updateSession("s-checkout", { autonomy: "auto" });
    updateSession.mockClear();
    renderWithClient(<FromSnapshot id="s-checkout" />, client);
    const trigger = await screen.findByRole("button", { name: "Permissions" });
    expect(trigger.textContent).toContain("Auto");

    toast.success.mockClear();
    await pickAutonomy("Full");
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s-checkout", { autonomy: "full" }),
    );
    // Claude takes it from the next tool call, even in a running turn.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Permissions: Full", {
        id: "session-options-s-checkout",
        description: "Applies from the next tool call.",
      }),
    );
    // The picker shows the session the server sent back.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permissions" }).textContent).toContain("Full"),
    );
  });

  it("says a running Codex turn keeps its level until the next turn", async () => {
    const client = createMockClient();
    const { queryClient } = renderWithClient(
      <SessionOptions
        session={agent({ provider: "codex", model: "default", autonomy: "auto" })}
        running
      />,
      client,
    );
    await waitFor(() => expect(queryClient.getQueryData(snapshotKey)).toBeTruthy());
    toast.success.mockClear();
    await pickAutonomy("Supervised");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Permissions: Supervised", {
        id: "session-options-s-checkout",
        description: "Applies from the next turn.",
      }),
    );
  });

  it("does not save when the same level is picked again", async () => {
    const client = createMockClient();
    const updateSession = vi.spyOn(client, "updateSession");
    renderWithClient(<SessionOptions session={agent({ autonomy: "auto" })} running />, client);
    await pickAutonomy("Auto");
    await new Promise((r) => setTimeout(r, 20));
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe("SessionOptions plan mode", () => {
  it("shows Plan where the provider has plan mode and saves a change with PATCH", async () => {
    const client = createMockClient();
    const updateSession = vi.spyOn(client, "updateSession");
    renderWithClient(<FromSnapshot id="s-checkout" />, client);
    const plan = await screen.findByRole("button", { name: "Plan mode" });
    expect(plan.getAttribute("aria-pressed")).toBe("false");

    toast.success.mockClear();
    fireEvent.click(plan);
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s-checkout", { planMode: true }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Plan mode on", {
        id: "session-options-s-checkout",
        description: "Applies from the next tool call.",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Plan mode" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("hides Plan for providers without plan mode and for role sessions", async () => {
    const client = createMockClient();
    const { queryClient, unmount } = renderWithClient(
      <SessionOptions session={agent({ provider: "codex", model: "default" })} running={false} />,
      client,
    );
    await waitFor(() => expect(queryClient.getQueryData(snapshotKey)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Plan mode" })).toBeNull();
    unmount();
    renderWithClient(<SessionOptions session={agent({ role: "pm" })} running={false} />, client);
    await screen.findByRole("button", { name: /opus/i });
    expect(screen.queryByRole("button", { name: "Plan mode" })).toBeNull();
  });
});
