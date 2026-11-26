import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelineRowView } from "@/components/thread/timeline-row";
import { renderWithClient } from "./utils";

const completedAt = "2026-11-12T10:01:00.000Z";

/** A finished turn of `s-search`'s own thread. */
const row = {
  key: "end:u1",
  type: "turn-end",
  filesChanged: 0,
  durationMs: 60_000,
  latest: true,
  turn: {
    id: "u1",
    threadId: "t-search",
    status: "completed",
    startedAt: "2026-11-12T10:00:00.000Z",
    completedAt,
    error: null,
    forkPoint: null,
  },
} as const;

describe("turn footer", () => {
  it("shows when the turn's reply was sent, the full date on hover (#653)", async () => {
    renderWithClient(<TimelineRowView row={row} sessionId="s-search" />, undefined, {
      withRouter: true,
    });
    await screen.findByText(/Worked for 1m 0s/);
    const time = document.querySelector(`time[datetime="${completedAt}"]`);
    expect(time).not.toBeNull();
    expect(time?.getAttribute("title")).toBe(new Date(completedAt).toLocaleString());
  });
});
