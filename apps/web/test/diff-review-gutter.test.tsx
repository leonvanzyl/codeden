import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommentButtonLabels } from "@/components/workbench/diff-review";

function Card() {
  const ref = useCommentButtonLabels();
  return <div ref={ref} data-testid="card" />;
}

/**
 * A stand-in for the diff view inside `card`: a line in a shadow root whose `pre`, like the
 * real view, inserts the "+" (reused once made) while handling `pointermove` over a line.
 */
function diffView(card: HTMLElement) {
  const view = document.createElement("diffs-container");
  card.append(view);
  const root = view.attachShadow({ mode: "open" });
  const pre = document.createElement("pre");
  const line = document.createElement("div");
  pre.append(line);
  root.append(pre);
  const state = { plus: null as HTMLButtonElement | null };
  pre.addEventListener("pointermove", () => {
    if (state.plus?.isConnected) return;
    state.plus = document.createElement("button");
    state.plus.setAttribute("data-utility-button", "");
    pre.append(state.plus);
  });
  return { line, state };
}

const pointer = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, composed: true, ...init });

describe("useCommentButtonLabels", () => {
  it("labels the diff's + on the first hover, as the view inserts it", () => {
    render(<Card />);
    const { line, state } = diffView(screen.getByTestId("card"));

    // Entering a line: the view hasn't made its "+" yet.
    line.dispatchEvent(pointer("pointerover"));
    expect(state.plus).toBeNull();

    // The view inserts the "+" while handling the move; the same event labels it on its way out.
    line.dispatchEvent(pointer("pointermove"));
    const plus = state.plus as HTMLButtonElement | null;
    expect(plus?.getAttribute("aria-label")).toBe("Comment");
    expect(plus?.title).toBe("Comment (drag for several lines)");

    // Moving from the line onto the "+" stays inside the shadow root and keeps the label.
    plus?.dispatchEvent(pointer("pointerover", { relatedTarget: line }));
    plus?.dispatchEvent(pointer("pointermove"));
    expect(plus?.getAttribute("aria-label")).toBe("Comment");
  });

  it("labels a + the view makes again later", () => {
    render(<Card />);
    const { line, state } = diffView(screen.getByTestId("card"));
    line.dispatchEvent(pointer("pointermove"));
    state.plus?.remove();
    line.dispatchEvent(pointer("pointermove"));
    expect(state.plus?.isConnected).toBe(true);
    expect(state.plus?.getAttribute("aria-label")).toBe("Comment");
  });
});
