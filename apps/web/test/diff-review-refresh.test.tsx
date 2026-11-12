import type { DiffResult, Session, Snapshot } from "@codeden/contracts";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffPanel } from "@/components/workbench/diff-panel";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { sessionComments, useDiffReviewStore } from "@/stores/diff-review";
import { renderWithClient } from "./utils";

/**
 * A stand-in for the diff view. Like the real one, it draws the patch's rows, offers a "+" per
 * row that reports the line to `onGutterUtilityClick`, and shows an annotation only under a
 * row it belongs to: the real view gives each line its own slot, so an annotation on a line
 * that isn't in the patch has nowhere to show.
 */
vi.mock("@pierre/diffs/react", async () => {
  const { parsePatchRows } = await import("@/lib/diff-review");
  function PatchDiff(props: {
    patch: string;
    options: { onGutterUtilityClick: (range: SelectedLineRange) => void };
    lineAnnotations?: DiffLineAnnotation[];
    renderAnnotation: (a: DiffLineAnnotation) => ReactNode;
  }) {
    const rows = parsePatchRows(props.patch);
    return (
      <div data-testid="patch">
        {rows.map((r) => {
          const side = r.marker === "-" ? "deletions" : "additions";
          const line = (side === "additions" ? r.newLine : r.oldLine) ?? 0;
          const here = (props.lineAnnotations ?? []).filter((a) =>
            a.side === "additions" ? a.lineNumber === r.newLine : a.lineNumber === r.oldLine,
          );
          return (
            <div key={`${side}:${line}`}>
              <div data-row={`${side}:${line}`}>
                <button
                  type="button"
                  aria-label={`+ ${side}:${line}`}
                  onClick={() =>
                    props.options.onGutterUtilityClick({
                      start: line,
                      side,
                      end: line,
                      endSide: side,
                    })
                  }
                />
                <code>{r.marker + r.text}</code>
              </div>
              {here.map((a) => (
                <div
                  key={`${a.side}:${a.lineNumber}`}
                  data-annotation={`${a.side}:${a.lineNumber}`}
                >
                  {props.renderAnnotation(a)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return { PatchDiff };
});

const sid = "s-refresh";
const path = "src/cart.ts";
const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;

/** The agent's first change: a guard on new line 2, the line the user comments on. */
const guarded = `${header}@@ -1,4 +1,5 @@
 export function total(items: Item[]) {
+  if (items.length === 0) return 0;
   let sum = 0;
   for (const item of items) sum += item.price;
   return sum;
`;

/** The next checkpoint: two lines added above the guard, which moves to new line 4. */
const linesAbove = `${header}@@ -1,4 +1,7 @@
+/** The cart total, in cents. */
+// Prices are integers.
 export function total(items: Item[]) {
+  if (items.length === 0) return 0;
   let sum = 0;
   for (const item of items) sum += item.price;
   return sum;
`;

/** A later checkpoint: the guard is gone and the only change is further down the file. */
const guardGone = `${header}@@ -20,3 +20,3 @@
 export function tax(sum: number) {
-  return sum * 0.15;
+  return Math.round(sum * 0.15);
 }
`;

const session = {
  id: sid,
  role: "agent",
  status: "running",
  provider: "claude",
  title: "Cart totals",
} as Session;

/**
 * A Diff panel on a running session. "All changes" and the one turn's view both show
 * `patch.current`; sent messages land in `sendMessage`.
 */
function renderPanel() {
  const patch = { current: guarded };
  const base = createMockClient();
  const sendMessage = vi.fn(async (..._args: Parameters<CodeDenClient["sendMessage"]>) => {});
  const client = {
    ...base,
    sendMessage,
    getSnapshot: async () => ({ sessions: [session] }) as unknown as Snapshot,
    gitStatus: async () => ({ branch: "b", baseBranch: "main", ahead: 0, behind: 0, files: [] }),
    getDiff: async (_id: string, scope: DiffResult["scope"]): Promise<DiffResult> => ({
      scope,
      files:
        scope.kind === "uncommitted"
          ? []
          : [{ path, change: "modify", additions: 1, deletions: 0, patch: patch.current }],
      turns: [{ id: "t-1", index: 1, label: "Turn 1", at: "2026-11-12T10:00:00.000Z" }],
    }),
  };
  const view = renderWithClient(<DiffPanel sessionId={sid} />, client);
  /** A new checkpoint: the panel refetches its diff, as `invalidateWorkbench` makes it. */
  const checkpoint = async (next: string, rowNowShown: string) => {
    patch.current = next;
    await view.queryClient.invalidateQueries({ queryKey: ["diff", sid] });
    await waitFor(() =>
      expect(document.querySelector(`[data-row="${rowNowShown}"]`)).not.toBeNull(),
    );
  };
  return { ...view, checkpoint, sendMessage };
}

/** Comment on a row with the diff's "+", type `text` and, unless `open`, save it. */
async function commentOn(row: string, text: string, opts: { open?: boolean } = {}) {
  fireEvent.click(await screen.findByRole("button", { name: `+ ${row}` }));
  const editor = await screen.findByRole("textbox", { name: /^Comment on/ });
  fireEvent.change(editor, { target: { value: text } });
  if (!opts.open) fireEvent.click(screen.getByRole("button", { name: "Comment" }));
}

/** The diff row a comment shows under, by the text it shows, or null when it isn't shown. */
function rowUnder(body: string): string | null {
  const annotation = screen.queryByText(body)?.closest("[data-annotation]");
  return annotation?.previousElementSibling?.querySelector("code")?.textContent ?? null;
}

/** Send to agent is disabled for an open editor, and no comment editor is on screen. */
function sendLockedWithNoEditorShown(): boolean {
  const send = screen.getByRole("button", { name: /Send to agent/ }) as HTMLButtonElement;
  const editors = screen.queryAllByRole("textbox", { name: /^Comment on/ });
  return send.disabled && editors.length === 0;
}

/** An editor left open in the Turn 1 view, which the panel isn't showing. */
function openEditorInTurnView(text: string) {
  useDiffReviewStore.getState().start(sid, {
    path,
    scopeKey: "turn:t-1",
    range: { start: 2, side: "additions", end: 2, endSide: "additions" },
    quote: ["+  if (items.length === 0) return 0;"],
  });
  const id = sessionComments(useDiffReviewStore.getState(), sid).at(-1)?.id ?? "";
  useDiffReviewStore.getState().setDraft(sid, id, text);
}

const outdatedList = () => within(screen.getByRole("region", { name: "Outdated comments" }));
const sendButton = () => screen.getByRole("button", { name: /Send to agent/ }) as HTMLButtonElement;

afterEach(() => {
  useDiffReviewStore.setState({ comments: {}, sending: {} });
  vi.restoreAllMocks();
});

describe("Diff review comments when the diff refreshes", () => {
  it("keeps a comment under its line when the agent adds lines above it", async () => {
    const { checkpoint, sendMessage } = renderPanel();
    await commentOn("additions:2", "Return early when empty.");
    expect(rowUnder("Return early when empty.")).toBe("+  if (items.length === 0) return 0;");

    await checkpoint(linesAbove, "additions:7");

    expect(rowUnder("Return early when empty.")).toBe("+  if (items.length === 0) return 0;");
    expect(screen.queryByRole("region", { name: "Outdated comments" })).toBeNull();
    // Labelled and sent with the line's number now, not the one it had when written.
    expect(await screen.findByText("Comment on new line 4")).toBeTruthy();
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[1].text).toContain(`${path}, new line 4`);
  });

  it("lists a comment whose line has left the diff as outdated, and still sends it as written", async () => {
    const { checkpoint, sendMessage } = renderPanel();
    await commentOn("additions:2", "Return early when empty.");

    await checkpoint(guardGone, "deletions:21");

    expect(screen.getByTestId("diff-review-bar").textContent).toContain("1 comment");
    expect(outdatedList().getByText("Return early when empty.")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Outdated comments" });
    expect(region.querySelector("pre")?.textContent).toBe("+  if (items.length === 0) return 0;");
    expect(rowUnder("Return early when empty.")).toBeNull();

    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const text = sendMessage.mock.calls[0]?.[1].text ?? "";
    expect(text).toContain(`${path}, new line 2`);
    expect(text).toContain("+  if (items.length === 0) return 0;\n```\nReturn early when empty.");
  });

  it("lets an outdated comment be edited and deleted on its own", async () => {
    const { checkpoint } = renderPanel();
    await commentOn("additions:2", "Return early when empty.");
    await commentOn("additions:3", "Name this subtotal.");
    await checkpoint(guardGone, "deletions:21");

    const [first] = outdatedList().getAllByRole("button", { name: "Edit comment" });
    fireEvent.click(first as HTMLElement);
    fireEvent.change(outdatedList().getByRole("textbox", { name: /^Comment on/ }), {
      target: { value: "Return 0 early for an empty cart." },
    });
    fireEvent.click(outdatedList().getByRole("button", { name: "Comment" }));
    expect(outdatedList().getByText("Return 0 early for an empty cart.")).toBeTruthy();

    const [, second] = outdatedList().getAllByRole("button", { name: "Delete comment" });
    fireEvent.click(second as HTMLElement);
    expect(outdatedList().queryByText("Name this subtotal.")).toBeNull();
    expect(screen.getByTestId("diff-review-bar").textContent).toContain("1 comment");
  });

  it("doesn't lock Send behind an open editor whose line has left the diff", async () => {
    const { checkpoint } = renderPanel();
    await commentOn("additions:3", "Name this subtotal.");
    await commentOn("additions:2", "Half-written thou", { open: true });
    expect(sendLockedWithNoEditorShown()).toBe(false);

    await checkpoint(guardGone, "deletions:21");

    expect(sendLockedWithNoEditorShown()).toBe(false);
  });

  it("says when the editor holding Send back is in another view, and Show goes to it", async () => {
    renderPanel();
    await commentOn("additions:2", "Return early when empty.");
    openEditorInTurnView("Half-written thou");
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("An unsaved comment in another view");
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show" }));

    expect(await screen.findByDisplayValue("Half-written thou")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Turn 1/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(sendLockedWithNoEditorShown()).toBe(false);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const card = scrolled.mock.contexts.at(-1) as HTMLElement;
    expect(card.getAttribute("data-comment-id")).not.toBeNull();
    expect(within(card).getByDisplayValue("Half-written thou")).toBeTruthy();
  });

  it("can cancel an editor in another view from the review bar, unblocking Send", async () => {
    renderPanel();
    await commentOn("additions:2", "Return early when empty.");
    openEditorInTurnView("Half-written thou");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel edit" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(sessionComments(useDiffReviewStore.getState(), sid)).toHaveLength(1);
  });
});
