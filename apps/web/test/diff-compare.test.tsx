import type { DiffResult, DiffScope, Session, Snapshot } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiffPanel } from "@/components/workbench/diff-panel";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/**
 * A stand-in for the diff view: its header's buttons (comment and restore), and whether the
 * "+" by each line, which starts a comment, is on.
 */
vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: (props: {
    patch: string;
    options: { enableGutterUtility: boolean };
    renderHeaderMetadata: () => ReactNode;
  }) => (
    <div data-testid="patch" data-comments={String(props.options.enableGutterUtility)}>
      {props.renderHeaderMetadata()}
      <pre>{props.patch}</pre>
    </div>
  ),
}));

const at = "2026-11-14T10:00:00.000Z";
const path = "src/cart.ts";
const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
const session = (id: string, patch: Partial<Session>) =>
  ({
    id,
    role: "agent",
    status: "idle",
    provider: "claude",
    projectId: "p1",
    createdAt: at,
    ...patch,
  }) as Session;
const source = session("s-source", { title: "Cart totals" });
const fork = session("s-fork", {
  title: "Cart totals, another way",
  forkedFrom: { sessionId: "s-source", checkpoint: 2 },
});

function renderFork(opts: { identical?: boolean } = {}) {
  const scopes: DiffScope[] = [];
  const client = {
    ...createMockClient(),
    getSnapshot: async () => ({ sessions: [source, fork], projects: [] }) as unknown as Snapshot,
    gitStatus: async () => ({ branch: "b", baseBranch: "main", ahead: 0, behind: 0, files: [] }),
    getDiff: async (_id: string, scope: DiffScope): Promise<DiffResult> => {
      scopes.push(scope);
      const files =
        opts.identical && scope.kind === "compare"
          ? []
          : [{ path, change: "modify" as const, additions: 1, deletions: 1, patch }];
      return {
        scope,
        files,
        turns: [],
        ...(scope.kind === "compare"
          ? { against: { sessionId: scope.sessionId, index: 2, at } }
          : {}),
      };
    },
  };
  renderWithClient(<DiffPanel sessionId="s-fork" />, client, { withRouter: true });
  return { scopes };
}

async function compareWithSource() {
  fireEvent.keyDown(await screen.findByRole("button", { name: /All changes/ }), { key: "Enter" });
  const item = await screen.findByRole("menuitem", { name: /Cart totals\s*source/ });
  fireEvent.click(item);
}

describe("Compare with a related session", () => {
  it("compares the fork with its source, read-only, and goes back to its own changes", async () => {
    const { scopes } = renderFork();
    expect((await screen.findByTestId("patch")).dataset.comments).toBe("true");
    expect(screen.getByRole("button", { name: `Restore ${path}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Comment on lines of ${path}` })).toBeTruthy();

    await compareWithSource();

    await waitFor(() => expect(scopes.at(-1)).toEqual({ kind: "compare", sessionId: "s-source" }));
    expect(await screen.findByRole("button", { name: /vs Cart totals/ })).toBeTruthy();
    const legend = await screen.findByTestId("compare-legend");
    expect(within(legend).getByRole("link", { name: "Cart totals" })).toBeTruthy();
    expect(legend.textContent).toContain("as of its last turn");
    expect(legend.textContent).toContain("this session, now");
    // No restoring another session's code, and no comments on it.
    await waitFor(() => expect(screen.getByTestId("patch").dataset.comments).toBe("false"));
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(screen.queryByRole("button", { name: `Comment on lines of ${path}` })).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: /vs Cart totals/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "All changes in this session" }));

    await waitFor(() => expect(screen.getByTestId("patch").dataset.comments).toBe("true"));
    expect(screen.queryByTestId("compare-legend")).toBeNull();
    expect(screen.getByRole("button", { name: `Restore ${path}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Comment on lines of ${path}` })).toBeTruthy();
  });

  it("says when both sessions have the same code", async () => {
    renderFork({ identical: true });
    await compareWithSource();
    expect(await screen.findByText("Same code as Cart totals")).toBeTruthy();
  });
});
