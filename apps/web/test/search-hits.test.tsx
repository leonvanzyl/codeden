import { TranscriptSearchResponse } from "@codeden/contracts";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { hitLinkSearch } from "@/lib/search";
import { SessionPage } from "@/routes/session";
import { useLayoutStore } from "@/stores/layout";
import { renderWithClient } from "./utils";

/**
 * A transcript search match inside a subagent's thread opens that thread at the item, beside
 * the session scrolled to the subagent card that started it (#166).
 */

afterEach(() => {
  vi.useRealTimers();
  useLayoutStore.setState({ childThread: null });
});

describe("opening a transcript search hit", () => {
  it("links a match in a subagent's thread to its card and to the item in the thread", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const pending = client.searchTranscripts({ q: "request-id guard" });
    await vi.advanceTimersByTimeAsync(500);
    const [hit] = TranscriptSearchResponse.parse(await pending).hits;
    expect(hit).toMatchObject({
      sessionId: "s-checkout",
      threadId: "t-checkout-review",
      itemId: "rv-5",
      anchorItemId: "ck-sub",
    });
    expect(hit && hitLinkSearch(hit)).toEqual({
      item: "ck-sub",
      thread: "t-checkout-review",
      threadItem: "rv-5",
    });
    // A match in the session's own thread only scrolls to the item.
    expect(
      hitLinkSearch({ itemId: "ck-u2", threadId: "t-checkout", anchorItemId: "ck-u2" }),
    ).toEqual({ item: "ck-u2" });
  });

  it("opens the subagent's thread in the side panel at the item", async () => {
    renderWithClient(
      <SessionPage
        sessionId="s-checkout"
        focusItemId="ck-sub"
        focusThread={{ threadId: "t-checkout-review", itemId: "rv-5" }}
      />,
      createMockClient(),
      { withRouter: true },
    );
    await waitFor(() =>
      expect(useLayoutStore.getState()).toMatchObject({
        childThread: {
          sessionId: "s-checkout",
          threadId: "t-checkout-review",
          focusItemId: "rv-5",
        },
        rightTab: "thread",
        rightOpen: true,
      }),
    );
  });
});
