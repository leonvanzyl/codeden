import type { DiffResult, Session, Snapshot } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DiffPanel } from "@/components/workbench/diff-panel";
import { createMockClient } from "@/lib/api/mock";
import { sessionComments, useDiffReviewStore } from "@/stores/diff-review";
import { renderWithClient } from "./utils";

/**
 * Diff review comments from the keyboard (#115), with the real diff view: it draws each file's
 * lines inside a shadow root and, on its own, only offers its "+" to a pointer.
 */

const sid = "s-keys";
const path = "src/cart.ts";
/** Rows: unchanged new 1, added new 2, removed old 2, added new 3, unchanged new 4 and 5. */
const patch = `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,4 +1,5 @@
 export function total(items: Item[]) {
+  if (items.length === 0) return 0;
-  let sum = 0;
+  let sum = 0; // cents
   for (const item of items) sum += item.price;
   return sum;
`;

const session = { id: sid, role: "agent", status: "idle", title: "Cart totals" } as Session;

function renderPanel() {
  const client = {
    ...createMockClient(),
    getSnapshot: async () => ({ sessions: [session], projects: [] }) as unknown as Snapshot,
    gitStatus: async () => ({ branch: "b", baseBranch: "main", ahead: 0, behind: 0, files: [] }),
    getDiff: async (_id: string, scope: DiffResult["scope"]): Promise<DiffResult> => ({
      scope,
      files: [{ path, change: "modify", additions: 2, deletions: 1, patch }],
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

/** Press Tab from the top of the page until `target` has the focus. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let i = 0; i < 40 && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement, "Tab never reaches the comment control").toBe(target);
}

/** Tab to the file's comment control and open its list of lines with Enter. */
async function openLines() {
  const user = userEvent.setup();
  renderPanel();
  const stop = commentStop(await fileCard());
  expect(stop, "no Tab stop in the file's diff starts a comment").toBeDefined();
  await tabTo(user, stop as HTMLElement);
  await user.keyboard("{Enter}");
  const list = await screen.findByRole("listbox", { name: `Lines of ${path}` });
  expect(document.activeElement).toBe(list);
  return { user, stop: stop as HTMLElement, list };
}

afterEach(() => {
  useDiffReviewStore.setState({ comments: {}, sending: {} });
});

describe("Diff review comments from the keyboard", () => {
  it("(control) the view's own + still shows, labelled, once a pointer moves over a line", async () => {
    renderPanel();
    const card = await fileCard();
    const line = card.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]");
    line?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }),
    );

    const plus = tabStops(card).find((el) => el.hasAttribute("data-utility-button"));
    expect(plus?.getAttribute("aria-label")).toBe("Comment");
  });

  it("offers a Tab stop in a file's diff that says it starts a comment, before any pointer use", async () => {
    renderPanel();
    const card = await fileCard();

    const stops = tabStops(card).map((el) => spoken(el).trim() || el.tagName);
    const stop = commentStop(card);
    expect(stop, `Tab stops in the file's diff: ${JSON.stringify(stops)}`).toBeDefined();
    expect(stop?.getAttribute("aria-label")).toContain(path);
  });

  it("puts the card's buttons in the file's header, beside its name and counts, not over them", async () => {
    renderPanel();
    const card = await fileCard();
    const comment = commentStop(card);
    const restore = screen.getByRole("button", { name: `Restore ${path}` });
    for (const button of [comment, restore]) {
      expect(button?.closest('[slot="header-metadata"]')).not.toBeNull();
    }
  });

  it("starts a comment on a line picked with the arrow keys and Enter", async () => {
    const { user } = await openLines();

    // The first row is `export function total`; one row down is the added guard, new line 2.
    await user.keyboard("{ArrowDown}{Enter}");

    const editor = await screen.findByRole("textbox", { name: "Comment on new line 2" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks several lines with Shift, across both sides of the diff", async () => {
    const { user } = await openLines();

    await user.keyboard("{ArrowDown}{ArrowDown}{Shift>}{ArrowDown}{/Shift}{Enter}");

    const editor = await screen.findByRole("textbox", {
      name: "Comment on old line 2 to new line 3",
    });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const [comment] = sessionComments(useDiffReviewStore.getState(), sid);
    expect(comment?.quote).toEqual(["-  let sum = 0;", "+  let sum = 0; // cents"]);
  });

  it("closes the list with Escape, back on the comment control, without a comment", async () => {
    const { user, stop } = await openLines();

    await user.keyboard("{ArrowDown}{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(stop);
    expect(sessionComments(useDiffReviewStore.getState(), sid)).toHaveLength(0);
  });
});
