import type { EventEnvelope, InboxItem, Session, Snapshot } from "@codeden/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveEffects } from "@/components/shell/live-effects";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { created, inboxItem, snapshot } from "./attention-fixtures";

/**
 * Issue #97: the toasts `LiveEffects` raises while a dark factory runs. Renders the real toaster
 * and feeds it inbox and session events shaped as the server raises them, `notify` included.
 */

const live = vi.hoisted(() => ({
  listener: null as ((env: EventEnvelope) => void) | null,
  snap: null as Snapshot | null,
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime", () => ({
  onLiveEvent: (listener: (env: EventEnvelope) => void) => {
    live.listener = listener;
    return () => {
      live.listener = null;
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api", () => ({ useClient: () => ({}) }));
vi.mock("@/lib/voice/read-aloud", () => ({ startReadAloud: () => () => {} }));
vi.mock("@/components/shell/use-attention", () => ({ useAttention: () => {} }));
vi.mock("@/lib/queries", () => ({
  snapshotKey: ["snapshot"],
  useSnapshot: () => ({ data: live.snap }),
}));
vi.mock("@/lib/platform", () => ({
  platform: { setBadge: () => {}, isFocused: () => true, notify: () => {} },
}));

const ts = "2026-11-12T10:00:00.000Z";

/** An agent session the user started (`factory: true`: one the dark factory started). */
const agent = (id: string, status: Session["status"], factory = false): Session =>
  makeSession({
    id,
    projectId: "p1",
    role: "agent",
    status,
    provider: "claude",
    purpose: `Fix bug in ${id}`,
    workKey: `issue:${id}`,
    startedBy: factory ? { kind: "pm", id: "factory" } : { kind: "user" },
  });

const sessionUpdated = (seq: number, session: Session): EventEnvelope => ({
  seq,
  sessionId: null,
  ts,
  type: "session.updated",
  payload: { session },
});

/**
 * The `run_failed` item the server raises with a failed turn (`runFailedInbox`): a failure, or
 * factory activity for a session the factory started.
 */
const runFailed = (session: Session): InboxItem =>
  inboxItem(`inbox:${session.id}:turn-1:failed`, "run_failed", {
    notify: session.startedBy.id === "factory" ? "factory" : "failure",
    sessionId: session.id,
    title: `Run failed: ${session.title ?? session.purpose}`,
    body: "The agent stopped after a failed command.",
  });

function setup() {
  live.snap = snapshot(1, []);
  const queryClient = new QueryClient();
  queryClient.setQueryData(["snapshot"], live.snap);
  render(
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <LiveEffects />
    </QueryClientProvider>,
  );
  return {
    emit: (env: EventEnvelope) => act(() => live.listener?.(env)),
  };
}

/**
 * Toasts the toaster holds (sonner keeps hidden ones in the DOM too). Sonner adds toasts on a
 * zero timeout, so let that run first.
 */
async function toastCount(): Promise<number> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelectorAll("[data-sonner-toast]").length;
}

afterEach(() => {
  act(() => toast.dismiss());
  navigate.mockReset();
});

describe("toasts while a dark factory runs (#97)", () => {
  it("does not toast a factory decision that needed nothing from the owner", async () => {
    const { emit } = setup();
    // As `recordDecision` raises it for `factory_record_decision` without needsHuman.
    emit(
      created(
        2,
        inboxItem("inbox:factory-decision:d1", "message", {
          priority: "low",
          notify: "factory",
          title: "Factory decided: Which test runner should the new suite use?",
          body: "**Decision:** Vitest\n\nNothing waited on you.",
        }),
      ),
    );
    expect(await toastCount()).toBe(0);
  });

  it("does not toast 'ready for review' for a PR the factory reviews and merges itself", async () => {
    const { emit } = setup();
    // As `PrReviewInbox` raises it for a factory builder's PR once its checks pass.
    emit(
      created(
        2,
        inboxItem("inbox:pr_review:p1:93", "pr_review", {
          notify: "factory",
          sessionId: "s-b1",
          title: "Ready for review: PR #93 Fix bug in s-b1",
          pr: {
            number: 93,
            url: "https://github.com/o/r/pull/93",
            state: "open",
            title: "Fix bug in s-b1",
          },
        }),
      ),
    );
    expect(await toastCount()).toBe(0);
  });

  it("raises one toast for one failed turn", async () => {
    const { emit } = setup();
    const running = agent("s-b1", "running");
    emit(sessionUpdated(2, running));
    // A failed turn: the session turns `failed` and a `run_failed` item is raised with it.
    emit(sessionUpdated(3, { ...running, status: "failed" }));
    emit(created(4, runFailed(running)));
    expect(await toastCount()).toBe(1);
  });

  it("collapses a burst of updates into one toast", async () => {
    const { emit } = setup();
    for (let i = 1; i <= 5; i++) emit(created(i + 1, runFailed(agent(`s-b${i}`, "failed"))));
    expect(await toastCount()).toBe(1);
    expect(screen.getByText("5 failures need a look")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open inbox" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/inbox", search: {} });
  });

  it("opens the failed session, not just the inbox", async () => {
    const { emit } = setup();
    emit(created(2, runFailed(agent("s-b1", "failed"))));
    expect(await screen.findByText("Run failed: Fix bug in s-b1")).toBeTruthy();
    expect(screen.getByText("The agent stopped after a failed command.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s-b1" },
    });
  });

  it("keeps a factory session's failure quiet: the factory handles it", async () => {
    const { emit } = setup();
    emit(created(2, runFailed(agent("s-b1", "failed", true))));
    expect(await toastCount()).toBe(0);
  });

  it("toasts a PR that needs a person to merge, and opens it in the inbox", async () => {
    const { emit } = setup();
    // As `readyForYou` raises it when auto-merge is off.
    emit(
      created(
        2,
        inboxItem("inbox:factory-ready:f1", "pr_review", {
          notify: "needs_you",
          title: "Ready to merge: Fix bug in s-b1",
          body: "Every factory check passed (tests, review); auto-merge is off. Merge it on GitHub.",
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/inbox",
      search: { item: "inbox:factory-ready:f1" },
    });
  });
});
