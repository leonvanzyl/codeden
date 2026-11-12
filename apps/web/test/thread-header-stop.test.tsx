import type { Session } from "@codeden/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadHeader } from "@/components/thread/thread-header";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
  }),
);
vi.mock("sonner", () => ({ toast }));

const agent = (status: Session["status"]): Session =>
  makeSession({
    id: "s-checkout",
    projectId: "p-storefront",
    role: "agent",
    status,
    provider: "claude",
    model: "opus",
    purpose: "Fix flaky checkout e2e test",
    workKey: "issue:142",
  });

/** Open the header's ⋯ menu and return the labels of its items. */
async function menuItems(session: Session): Promise<string[]> {
  renderWithClient(<ThreadHeader session={session} running={false} />, createMockClient(), {
    withRouter: true,
  });
  const trigger = await screen.findByRole("button", { name: "More" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  return items.map((item) => item.textContent?.trim() ?? "");
}

describe("thread header ⋯ menu (#116)", () => {
  it.each(["completed", "idle", "failed", "interrupted", "stopped"] as const)(
    "offers no Stop session on a %s session",
    async (status) => {
      const labels = await menuItems(agent(status));
      expect(labels.some((l) => /Archive session/.test(l))).toBe(true);
      expect(labels.some((l) => /Stop session/.test(l))).toBe(false);
    },
  );

  it.each(["running", "waiting"] as const)(
    "offers Stop session while the session is %s",
    async (status) => {
      const labels = await menuItems(agent(status));
      expect(labels.some((l) => /Stop session/.test(l))).toBe(true);
    },
  );
});
