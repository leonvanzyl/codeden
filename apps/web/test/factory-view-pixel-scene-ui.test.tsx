import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PixelScene } from "@/components/factory-view/pixel/pixel-scene";
import { type SessionInfo, viewPipeline } from "@/components/factory-view/stages";
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
  ],
});
const sessions = new Map<string, SessionInfo>([["s1", running("Wiring the wishlist button", 2)]]);

function renderScene() {
  const onOpen = vi.fn();
  const setOpen = vi.fn();
  const client = createMockClient();
  const retry = vi.spyOn(client.factory, "retry").mockResolvedValue({} as never);
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
  return { onOpen, setOpen, retry };
}

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
      "1 in the repair bay",
    );
  });
});
