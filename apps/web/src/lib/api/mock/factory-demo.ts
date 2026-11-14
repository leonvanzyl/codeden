import {
  FactoryLoop,
  type FactoryPrEntry,
  type FactoryStatus,
  type FactoryWorkItem,
  type Item,
  type Session,
} from "@codeden/contracts";
import { startActivityDemo } from "./factory-demo-activity";
import { Script, streamSteps, uid } from "./live";
import type { MockWorld } from "./world";

/**
 * A busy factory for the Factory view in the mock UI (#264): while the storefront's Factory view
 * is open, a short script moves its work along every few seconds so pixel mode has real
 * transitions to act out. A build starts from the pile, a build reaches review, a review passes
 * into the merge queue, a pull request merges, a rebase reports progress, a build fails into the
 * repair bay, and the PM replies in its chat. Then it starts over. Mock only: the real server
 * never runs this, and nothing here calls a model.
 */

const PROJECT = "p-storefront";
const BEAT_MS = 4000;
const PM = "s-pm-storefront";

const at = () => new Date().toISOString();

/** Sessions the demo's agents speak for, so their cards name a provider and a model. */
function demoSessions(world: MockWorld): Session[] {
  const base = world.session("s-search");
  if (!base) return [];
  const make = (id: string, patch: Partial<Session>): Session => ({
    ...base,
    id,
    issue: null,
    pr: null,
    createdAt: at(),
    updatedAt: at(),
    ...patch,
  });
  return [
    make("s-demo-build-151", {
      title: "Dark mode for the storefront",
      provider: "claude",
      model: "opus",
      workKey: "issue:151",
      status: "running",
      progress: null,
    }),
    make("s-demo-review-57", {
      title: "Review: Product search with filters",
      provider: "codex",
      model: "gpt-6.1-sol",
      workKey: "factory:review:57",
      status: "running",
      progress: { text: "Reading the diff of #57", at: at() },
    }),
    make("s-demo-review-59", {
      title: "Review: Coupon total rounds the wrong way",
      provider: "codex",
      model: "gpt-6.1-sol-mini",
      workKey: "factory:review:59",
      status: "running",
      progress: { text: "Checks pass; waiting for CI on #59", at: at() },
    }),
  ];
}

type Change = (f: FactoryStatus) => FactoryStatus;

const patchItem =
  (id: string, patch: Partial<FactoryWorkItem>): Change =>
  (f) => {
    const all = [...f.backlog, ...f.inProgress, ...f.recent, ...f.viewRecent];
    const item = all.find((w) => w.id === id);
    if (!item) return f;
    const next = { ...item, ...patch, updatedAt: at() };
    const live = ["candidate", "backlog"].includes(next.stage)
      ? "backlog"
      : ["building", "verifying", "watching"].includes(next.stage)
        ? "inProgress"
        : "recent";
    const drop = (list: FactoryWorkItem[]) => list.filter((w) => w.id !== id);
    const out = {
      ...f,
      backlog: drop(f.backlog),
      inProgress: drop(f.inProgress),
      recent: drop(f.recent),
      viewRecent: drop(f.viewRecent),
    };
    if (live === "recent")
      return { ...out, recent: [next, ...out.recent], viewRecent: [next, ...out.viewRecent] };
    return { ...out, [live]: [...out[live], next] };
  };

const patchPr =
  (itemId: string, patch: Partial<FactoryPrEntry> | null): Change =>
  (f) => {
    const rest = f.pullRequests.filter((p) => p.itemId !== itemId);
    const was = f.pullRequests.find((p) => p.itemId === itemId);
    if (!patch) return { ...f, pullRequests: rest };
    const item = f.inProgress.find((w) => w.id === itemId);
    const base: FactoryPrEntry = was ?? {
      itemId,
      title: item?.title ?? itemId,
      pr: item?.pr ?? { number: 0, url: "", state: "open" },
      state: "checking",
      queuePosition: null,
      note: null,
    };
    return { ...f, pullRequests: [...rest, { ...base, ...patch }] };
  };

const all =
  (...changes: Change[]): Change =>
  (f) =>
    changes.reduce((acc, c) => c(acc), f);

/** The PM answers a question in its chat, streamed like any session. */
function pmReply(world: MockWorld): Script {
  const threadId = world.transcript(PM).rootThreadId ?? `t-${PM}`;
  const ids = { sessionId: PM, threadId, turnId: uid("pm-demo") };
  const replyId = uid("pm-a");
  const reply =
    "Busy floor: #139 is in review, #150 passed and is queued to merge, and #156 just shipped. #148 is rebasing onto main. I'll retry #155 once its builder is free.";
  const done = (item: Item) => world.emitAgent(PM, { type: "item.completed", ...ids, item });
  return new Script([
    {
      wait: 0,
      run: () => {
        world.updateSession(PM, { status: "running", progress: { text: "Answering", at: at() } });
        world.emitAgent(PM, { type: "turn.started", ...ids });
        done({
          id: uid("pm-u"),
          kind: "user_message",
          status: "completed",
          input: { text: "How's the factory doing?", attachments: [] },
        });
      },
    },
    {
      wait: 1200,
      run: () =>
        world.emitAgent(PM, {
          type: "item.started",
          ...ids,
          item: { id: replyId, kind: "assistant_message", status: "in_progress", text: "" },
        }),
    },
    ...streamSteps(world, { ...ids, itemId: replyId }, reply, "text", 70),
    {
      wait: 300,
      run: () => {
        done({ id: replyId, kind: "assistant_message", status: "completed", text: reply });
        world.emitAgent(PM, {
          type: "turn.completed",
          ...ids,
          forkPoint: ids.turnId,
          stopReason: "end_turn",
        });
        world.updateSession(PM, { status: "idle" });
      },
    },
  ]);
}

/** Starts the demo; returns a stop function. */
export function startFactoryDemo(world: MockWorld): () => void {
  let beat = 0;
  let script: Script | null = null;
  const onView = () =>
    typeof window !== "undefined" &&
    window.location.pathname === `/projects/${PROJECT}/factory/view`;
  const notify = () => {
    const f = world.factory.get(PROJECT);
    world.emitDomain({
      type: "factory.loop.updated",
      sessionId: null,
      payload: {
        loop: FactoryLoop.parse({
          projectId: PROJECT,
          state: f?.loopState ?? "building",
          pausedReason: null,
          consecutiveFailures: 0,
          day: at().slice(0, 10),
          mergesToday: f?.mergesToday ?? 0,
          discovery: [],
          nextArea: 0,
          lastDiscoveryAt: null,
          lastDigestDay: null,
          enabledAt: null,
          lastTickAt: at(),
          updatedAt: at(),
        }),
      },
    });
  };
  const apply = (change: Change) => {
    const f = world.factory.get(PROJECT);
    if (f) world.factory.set(PROJECT, change(f));
  };
  const progress = (id: string, text: string) =>
    world.updateSession(id, { progress: { text, at: at() } });

  const beats: (() => void)[] = [
    // Setup: the demo's sessions, and a reviewer on #150 waiting for CI.
    () => {
      for (const s of demoSessions(world))
        if (!world.session(s.id))
          world.emitDomain({ type: "session.created", sessionId: null, payload: { session: s } });
      apply(
        all(
          patchItem("fw-13", {
            reviewerSessionId: "s-demo-review-59",
            activeSessionId: "s-demo-review-59",
          }),
        ),
      );
    },
    // A build starts: the builder walks in from the pile with its ticket.
    () =>
      apply(
        patchItem("fw-1", {
          stage: "building",
          step: "analyze",
          sessionId: "s-demo-build-151",
          activeSessionId: "s-demo-build-151",
          stepSince: at(),
        }),
      ),
    // A build reaches review: the builder carries its PR crate to the review desk.
    () =>
      apply(
        all(
          patchItem("fw-5", {
            stage: "verifying",
            step: "review",
            reviewerSessionId: "s-demo-review-57",
            activeSessionId: "s-demo-review-57",
            stepSince: at(),
          }),
          patchPr("fw-5", {
            state: "checking",
            pr: {
              number: 57,
              url: "https://github.com/hearth-co/storefront/pull/57",
              state: "open",
            },
          }),
        ),
      ),
    // The review passes: the reviewer stamps the crate and puts it on the conveyor.
    () =>
      apply(
        all(
          patchItem("fw-13", { step: "merge", stepSince: at() }),
          patchPr("fw-13", {
            state: "queued",
            queuePosition: 3,
            note: "Every check passed; queued to merge",
          }),
        ),
      ),
    // A merge: the crate rides out of the shipping door and the counter goes up.
    () =>
      apply(
        all(
          patchItem("fw-15", { stage: "merged", step: "done", mergedAt: at(), finishedAt: at() }),
          patchPr("fw-15", null),
          (f) => ({
            ...f,
            mergesToday: f.mergesToday + 1,
            stats: { ...f.stats, mergedToday: f.stats.mergedToday + 1 },
          }),
        ),
      ),
    // The rebase reports progress, and the PM is asked how it's going.
    () => {
      progress("s-search", "Resolving the conflicts in cart-drawer.tsx");
      script?.cancel();
      script = pmReply(world).start();
    },
    // A build fails into the repair bay: a puff of smoke and a slump.
    () =>
      apply(
        patchItem("fw-12", {
          stage: "failed",
          step: "stopped",
          failureKind: "checks",
          reason: "The builder stopped without reporting its result",
          finishedAt: at(),
        }),
      ),
    () => progress("s-demo-review-57", "Two findings so far; writing the verdict"),
    () => {},
    // Start over from the fixtures.
    () => {
      world.factory.delete(PROJECT);
      beat = -1;
    },
  ];

  const timer = window.setInterval(() => {
    if (!onView() || !world.factory.get(PROJECT)) return;
    beats[beat]?.();
    beat = (beat + 1) % beats.length;
    notify();
  }, BEAT_MS);
  const stopActivity = startActivityDemo(world, onView);
  return () => {
    window.clearInterval(timer);
    stopActivity();
    script?.cancel();
  };
}
