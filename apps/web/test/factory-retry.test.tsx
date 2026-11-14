import { FactoryWorkItem } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecentColumn } from "@/components/factory/factory-columns";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/**
 * #259: a stopped item is retried from the factory panel itself, not only from its page. With
 * its pull request still open, Retry sends that PR back to review (no new build).
 */

const at = "2026-11-14T08:00:00.000Z";
const pr = { number: 172, url: "https://github.com/acme/app/pull/172", state: "open" as const };

const work = (patch: Partial<FactoryWorkItem>): FactoryWorkItem =>
  FactoryWorkItem.parse({
    id: "item-1",
    title: "Fix the login timeout",
    workKey: "issue:170",
    issue: { number: 170, url: "https://github.com/acme/app/issues/170", title: "Login" },
    pr: null,
    score: null,
    sessionId: null,
    stage: "failed",
    source: "issue",
    reason: "review: request_changes: still has gaps",
    note: "Stopped after 2 revise rounds; needs a re-review (Retry)",
    updatedAt: at,
    ...patch,
  });

describe("Retry on the factory panel (#259)", () => {
  it("shows Retry for a failed item and sends its open PR back to review", async () => {
    const client = createMockClient();
    const retry = vi.fn(async () => ({}) as never);
    client.factory.retry = retry;
    const failed = work({ pr, ownedPr: pr });
    const merged = work({ id: "item-2", title: "Add CSV export", stage: "merged", pr: null });
    renderWithClient(<RecentColumn projectId="p-app" recent={[failed, merged]} />, client, {
      withRouter: true,
    });
    const button = await screen.findByTestId("factory-retry");
    // Only the stopped item has it.
    expect(screen.getAllByTestId("factory-retry")).toHaveLength(1);
    expect(button.getAttribute("title")).toMatch(/#172 back to a fresh review/);
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p-app", "item-1", {}));
  });

  it("offers a rebuild for a stopped item without an open PR", async () => {
    renderWithClient(
      <RecentColumn
        projectId="p-app"
        recent={[work({ stage: "rejected", reason: "Could not reproduce" })]}
      />,
      createMockClient(),
      { withRouter: true },
    );
    const button = await screen.findByTestId("factory-retry");
    expect(button.getAttribute("title")).toMatch(/from the first step/);
  });
});
