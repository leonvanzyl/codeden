import type { DiffResult, Session, Snapshot } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DiffPanel } from "@/components/workbench/diff-panel";
import { createMockClient } from "@/lib/api/mock";
import { useDiffReviewStore } from "@/stores/diff-review";
import { renderWithClient } from "./utils";

/**
 * Diff review comments from the keyboard (#115), with the real diff view: it draws each file's
 * lines inside a shadow root and, on its own, only offers its "+" to a pointer.
 */

const sid = "s-keys";
const path = "src/cart.ts";
const patch = `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,4 +1,5 @@
 export function total(items: Item[]) {
+  if (items.length === 0) return 0;
   let sum = 0;
   for (const item of items) sum += item.price;
   return sum;
`;

const session = { id: sid, role: "agent", status: "idle", title: "Cart totals" } as Session;

function renderPanel() {
  const client = {
    ...createMockClient(),
    getSnapshot: async () => ({ sessions: [session] }) as unknown as Snapshot,
    gitStatus: async () => ({ branch: "b", baseBranch: "main", ahead: 0, behind: 0, files: [] }),
    getDiff: async (_id: string, scope: DiffResult["scope"]): Promise<DiffResult> => ({
      scope,
      files: [{ path, change: "modify", additions: 1, deletions: 0, patch }],
      turns: [],
    }),
  };
  return renderWithClient(<DiffPanel sessionId={sid} />, client);
}

/** The file's diff card once the view has drawn its lines. */
async function fileCard(): Promise<HTMLElement> {
  return waitFor(() => {
    const card = document.querySelector<HTMLElement>(`[data-file="${path}"]`);
    const lines = card
      ?.querySelector("diffs-container")
      ?.shadowRoot?.querySelectorAll("[data-line]");
    expect(lines?.length).toBeGreaterThan(0);
    return card as HTMLElement;
  });
}

/** Every Tab stop under `node` in document order, looking into open shadow roots as Tab does. */
function tabStops(node: ParentNode): HTMLElement[] {
  const stops: HTMLElement[] = [];
  for (const el of node.children) {
    if (el instanceof HTMLElement && el.tabIndex >= 0 && !el.matches(":disabled")) stops.push(el);
    if (el.shadowRoot) stops.push(...tabStops(el.shadowRoot));
    stops.push(...tabStops(el));
  }
  return stops;
}

/** What assistive technology reads for an element: its name and description. */
function spoken(el: HTMLElement): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const refs = [el.getAttribute("aria-labelledby"), el.getAttribute("aria-describedby")]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById?.(id)?.textContent ?? "");
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("aria-description"),
    el.getAttribute("title"),
    el.textContent,
    ...refs,
  ].join(" ");
}

/** The first Tab stop in the file's diff that tells the user it starts a comment. */
const commentStop = (card: HTMLElement) => tabStops(card).find((el) => /comment/i.test(spoken(el)));

afterEach(() => {
  useDiffReviewStore.setState({ comments: {}, sending: {} });
});

describe("Diff review comments from the keyboard", () => {
  it("(control) finds the view's own + once a pointer moves over a line", async () => {
    renderPanel();
    const card = await fileCard();
    const line = card.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]");
    line?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }),
    );

    const stop = commentStop(card);
    expect(stop?.hasAttribute("data-utility-button")).toBe(true);
    expect(stop?.getAttribute("aria-label")).toBe("Comment");
  });

  it("offers a Tab stop in a file's diff that says it starts a comment, before any pointer use", async () => {
    renderPanel();
    const card = await fileCard();

    const stops = tabStops(card).map((el) => spoken(el).trim() || el.tagName);
    expect(
      commentStop(card),
      `Tab stops in the file's diff: ${JSON.stringify(stops)}`,
    ).toBeDefined();
  });

  it("starts a comment on a line picked with the arrow keys and Enter", async () => {
    const user = userEvent.setup();
    renderPanel();
    const stop = commentStop(await fileCard());
    expect(stop, "no Tab stop in the file's diff starts a comment").toBeDefined();
    stop?.focus();

    // The first row is `export function total`; one row down is the added guard, new line 2.
    await user.keyboard("{ArrowDown}{Enter}");

    const editor = await screen.findByRole("textbox", { name: "Comment on new line 2" });
    expect(document.activeElement).toBe(editor);
  });
});
