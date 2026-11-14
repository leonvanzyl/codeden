import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PixelScene } from "@/components/factory-view/pixel/pixel-scene";
import { type SessionInfo, viewPipeline } from "@/components/factory-view/stages";
import type { TranscriptWatchMessage } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { minutesAgo, NOW, prRef, running, status, w } from "./pixel-fixtures";
import { renderWithClient } from "./utils";

/**
 * Issue #264: in pixel mode every agent says what it is doing on hover or keyboard focus, opens
 * its item on click and links its session; the PM focuses its chat; the repair bay's crates say
 * why work stopped and retry it with the same action as the item page. The canvas itself isn't
 * drawn in jsdom: the buttons and cards over it carry the facts.
 */

beforeAll(() => {
  // jsdom has no 2D canvas; the scene draws nothing without one.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const f = status({
  mode: "software_factory",
  scout: null,
  inProgress: [
    w("build", 4, {
      step: "implement",
      sessionId: "s1",
      activeSessionId: "s1",
      stepSince: minutesAgo(12),
    }),
  ],
  recent: [
    w("stopped", 9, {
      stage: "failed",
      step: "stopped",
      pr: prRef(21),
      ownedPr: prRef(21),
      attempts: 2,
      failureKind: "checks",
      finishedAt: minutesAgo(20),
    }),
    // A second crate after it: keyboard users must still reach the first crate's Retry.
    w("protected", 10, {
      stage: "escalated",
      step: "merge",
      pr: prRef(30),
      reason: "Touches a protected area (src/payments): yours to merge",
      finishedAt: minutesAgo(30),
    }),
  ],
});

/** The element the Tab key reaches after `el`, in document order. */
function nextFocusable(el: Element): Element | undefined {
  const all = [...document.querySelectorAll("button:not([disabled]), a[href], input, textarea")];
  return all[all.indexOf(el) + 1];
}
const sessions = new Map<string, SessionInfo>([["s1", running("Wiring the wishlist button", 2)]]);

function renderScene() {
  const onOpen = vi.fn();
  const setOpen = vi.fn();
  const client = createMockClient();
  const retry = vi.spyOn(client.factory, "retry").mockResolvedValue({} as never);
  // The server's per-session watch: the test sends the rows a live session changes.
  const watches = new Map<string, (msg: TranscriptWatchMessage) => void>();
  vi.spyOn(client, "watchSession").mockImplementation((id, _seq, listener) => {
    watches.set(id, listener);
    return () => watches.delete(id);
  });
  renderWithClient(
    <PixelScene
      f={f}
      pipeline={viewPipeline(f, sessions, NOW)}
      sessions={sessions}
      projectId="p1"
      now={NOW}
      onOpen={onOpen}
      chat={{ docked: true, open: false, setOpen }}
    />,
    client,
    { withRouter: true },
  );
  return { onOpen, setOpen, retry, watches };
}

const row = (id: string, item: Record<string, unknown>) => ({
  sessionId: "s1",
  threadId: "t1",
  turnId: "u1",
  position: 0,
  item: { id, status: "in_progress", ...item },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("pixel mode's agents and repair bay (#264)", () => {
  it("names each agent's button with what it is doing, and shows its card on focus", async () => {
    const { onOpen } = renderScene();
    const builder = await screen.findByRole("button", {
      name: "Builder, #4 Item 4, Implementing, Working",
    });
    fireEvent.focus(builder);
    const card = await screen.findByTestId("factory-view-pixel-card");
    expect(within(card).getByText("Builder")).toBeTruthy();
    expect(within(card).getByText("Working")).toBeTruthy();
    expect(within(card).getByText("Implementing")).toBeTruthy();
    expect(within(card).getByText("12 min")).toBeTruthy();
    expect(within(card).getByText("Claude Code · opus")).toBeTruthy();
    expect(within(card).getByText("“Wiring the wishlist button”")).toBeTruthy();
    expect(within(card).getByTestId("factory-view-pixel-card-session").getAttribute("href")).toBe(
      "/sessions/s1",
    );
    fireEvent.click(builder);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ id: "build" }) }),
    );
  });

  it("focuses the PM chat when the PM is clicked", async () => {
    const { setOpen } = renderScene();
    fireEvent.click(await screen.findByRole("button", { name: /^Project manager,/ }));
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("says why a crate's work stopped and retries it like the item page", async () => {
    const { retry } = renderScene();
    const crate = await screen.findByRole("button", { name: "Repair bay, Needs a retry: 1 item" });
    fireEvent.focus(crate);
    const card = await screen.findByTestId("factory-view-pixel-bay-card");
    expect(within(card).getByText("Stopped after 2 revise rounds; needs a re-review")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Retry #9" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1", "stopped", {}));
    expect(screen.getByTestId("factory-view-pixel-summary").textContent).toContain(
      "2 in the repair bay",
    );
  });
});

describe("pixel mode from the keyboard (#264)", () => {
  it("tabs from a crate into its own card, so every crate's Retry can be reached", async () => {
    const { retry } = renderScene();
    const first = await screen.findByRole("button", { name: "Repair bay, Needs a retry: 1 item" });
    expect(screen.getByRole("button", { name: "Repair bay, Yours to merge: 1 item" })).toBeTruthy();
    // Screen readers hear what the crate holds and why.
    expect(first.getAttribute("aria-describedby")).toBeTruthy();
    const about = document.getElementById(first.getAttribute("aria-describedby") ?? "");
    expect(about?.textContent).toBe("#9 Item 9: Stopped after 2 revise rounds; needs a re-review.");
    fireEvent.focus(first);
    const card = await screen.findByTestId("factory-view-pixel-bay-card");
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.getAttribute("aria-controls")).toBe(card.id);
    // The next stop after the crate is in its card (the item's link, then Retry), not the
    // next crate.
    const link = nextFocusable(first);
    expect(card.contains(link ?? null)).toBe(true);
    const retryButton = within(card).getByRole("button", { name: "Retry #9" });
    expect(nextFocusable(link as Element)).toBe(retryButton);
    // Moving focus into the card keeps it open.
    fireEvent.blur(first);
    fireEvent.focus(retryButton);
    fireEvent.click(retryButton);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1", "stopped", {}));
    expect(screen.getByTestId("factory-view-pixel-bay-card")).toBe(card);
  });

  it("tabs from an agent into its card's Open item and Open session", async () => {
    renderScene();
    const builder = await screen.findByRole("button", { name: /^Builder, #4/ });
    fireEvent.focus(builder);
    const card = await screen.findByTestId("factory-view-pixel-card");
    expect(nextFocusable(builder)).toBe(within(card).getByRole("button", { name: "Open item" }));
    const open = within(card).getByRole("button", { name: "Open item" });
    expect(nextFocusable(open)).toBe(within(card).getByTestId("factory-view-pixel-card-session"));
  });
});

describe("pixel mode's thought bubbles (#264)", () => {
  it("shows a live agent's latest tool call, without its arguments, and lists it on hover", async () => {
    const { watches } = renderScene();
    await waitFor(() => expect(watches.has("s1")).toBe(true));
    // Only live sessions on screen are watched.
    expect([...watches.keys()]).toEqual(["s1"]);
    act(() =>
      watches.get("s1")?.({
        type: "transcript",
        sessionId: "s1",
        seq: 1,
        threads: [],
        turns: [],
        items: [
          row("c1", {
            kind: "tool_call",
            toolKind: "command",
            toolName: "Bash",
            command: "API_TOKEN=ghp_0123456789abcdefghij0123456789 pnpm test --filter web",
          }),
        ],
      } as never),
    );
    const bubble = await screen.findByTestId("factory-view-pixel-bubble");
    expect(bubble.textContent).toBe("Run pnpm test");
    expect(bubble.dataset.kind).toBe("run");
    fireEvent.focus(screen.getByRole("button", { name: /^Builder, #4/ }));
    const recent = await screen.findByTestId("factory-view-pixel-card-activity");
    expect(within(recent).getByText("Run pnpm test")).toBeTruthy();
    expect(document.body.textContent).not.toContain("ghp_");
  });
});
