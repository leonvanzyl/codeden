import { describe, expect, it } from "vitest";
import { agentCard, agentLabel, stepTime } from "@/components/factory-view/pixel/agent-card";
import { type SceneAgent, sceneAgents } from "@/components/factory-view/pixel/agents";
import { labelOf } from "@/components/factory-view/pixel/draw-agents";
import { stationOf } from "@/components/factory-view/pixel/floor";
import { lookOf } from "@/components/factory-view/pixel/people";
import type { SessionInfo } from "@/components/factory-view/stages";
import {
  inputs,
  minutesAgo,
  NOW,
  prEntry,
  prRef,
  running,
  scoutStatus,
  status,
  w,
} from "./pixel-fixtures";

/**
 * Issue #264: every agent on the pixel floor says what it is doing. The agents model maps the
 * factory's state to a role, step and status per agent; the card says it in words.
 */

const sessions = new Map<string, SessionInfo>([
  // Reported progress 2 minutes ago, inside its 10-minute step: working.
  ["s-impl", running("Wiring the wishlist button", 2)],
  // Running, but its last line is older than its step: thinking.
  ["s-think", running("Old line", 30)],
  ["s-start", { status: "starting", progress: null, provider: "Codex", model: "gpt-6.1-sol" }],
  ["s-ask", { status: "waiting", progress: null, provider: "Claude Code", model: "opus" }],
  ["s-dead", { status: "failed", progress: null, provider: "Codex", model: null }],
  ["s-cut", { status: "interrupted", progress: null }],
  [
    "s-review",
    running("Checking the rounding", 1, {
      provider: "Codex",
      model: "gpt-6.1-sol",
      workKey: "factory:review:59",
    }),
  ],
  ["s-rebase", running("Resolving conflicts in cart.ts", 3, { workKey: "issue:148" })],
  ["s-int", running(null, 0, { workKey: "factory:integrate:53" })],
  ["s-pm", running("Answering", 0, { workKey: "pm:shop" })],
  ["scout", running("Planning", 0, { workKey: "factory:scout" })],
  ["l2", running("Profiling", 1, { workKey: "factory:lens:performance" })],
]);

const inProgress = [
  w("repro", 1, { step: "reproduce", type: "bug", activeSessionId: "s-impl", sessionId: "s-impl" }),
  w("analyze", 2, { step: "analyze", activeSessionId: "s-think", sessionId: "s-think" }),
  w("impl", 3, { step: "implement", activeSessionId: "s-start", sessionId: "s-start" }),
  w("revise", 4, { step: "implement", attempts: 2, sessionId: "s-dead" }),
  w("free", 5, { step: "implement" }),
  w("asks", 6, { step: "implement", activeSessionId: "s-ask", sessionId: "s-ask" }),
  w("cut", 7, { step: "implement", activeSessionId: "s-cut" }),
  w("review", 8, {
    stage: "verifying",
    step: "review",
    pr: prRef(59),
    sessionId: "s-b",
    reviewerSessionId: "s-review",
    activeSessionId: "s-review",
  }),
  w("ci", 9, { stage: "verifying", step: "review", pr: prRef(60), reviewerSessionId: "s-review" }),
  w("queued", 10, { stage: "verifying", step: "merge", pr: prRef(61) }),
  w("rebasing", 11, {
    stage: "verifying",
    step: "merge",
    pr: prRef(53),
    activeSessionId: "s-rebase",
  }),
  w("integrate", 12, {
    stage: "verifying",
    step: "review",
    pr: prRef(54),
    activeSessionId: "s-int",
  }),
  w("watching", 13, { stage: "watching", step: "merge", pr: prRef(62), mergedAt: minutesAgo(3) }),
  w("stuck", 14, { stage: "verifying", step: "merge", pr: prRef(63) }),
];
const pullRequests = [
  prEntry("review", 59, { state: "checking" }),
  prEntry("ci", 60, { state: "waiting_ci" }),
  prEntry("queued", 61, { state: "queued", queuePosition: 2 }),
  prEntry("rebasing", 53, { state: "rebasing" }),
  prEntry("integrate", 54, { state: "rebasing" }),
  prEntry("stuck", 63, { state: "stuck" }),
];

const agents = sceneAgents(inputs(status({ inProgress, pullRequests }), sessions, "s-pm"));
const byItem = (id: string) => agents.find((a) => a.card?.item.id === id) as SceneAgent;
const facts = (a: SceneAgent) => [a.role, a.step, a.status, a.blockedOn];

describe("pixel mode's agents (#264)", () => {
  it("gives each builder its step from the pipeline, and revising after a review round", () => {
    expect(facts(byItem("repro"))).toEqual(["builder", "reproducing", "working", null]);
    expect(facts(byItem("analyze"))).toEqual(["builder", "analyzing", "thinking", null]);
    expect(facts(byItem("impl"))).toEqual(["builder", "implementing", "thinking", null]);
    expect(facts(byItem("revise"))).toEqual(["builder", "revising", "blocked", "failed"]);
    expect(byItem("revise").failed).toBe(true);
  });

  it("says when a builder waits for approval, a free agent, or was cut off", () => {
    expect(facts(byItem("asks"))).toEqual(["builder", "implementing", "approval", null]);
    expect(facts(byItem("free"))).toEqual(["builder", "implementing", "blocked", "agent"]);
    expect(facts(byItem("cut"))).toEqual(["builder", "implementing", "blocked", "cut_off"]);
  });

  it("has a reviewer reviewing, watching CI, and then merging in queue order", () => {
    expect(facts(byItem("review"))).toEqual(["reviewer", "reviewing", "working", null]);
    expect(byItem("review").sessionId).toBe("s-review");
    expect(facts(byItem("ci"))).toEqual(["reviewer", "watching_ci", "blocked", "ci"]);
    expect(facts(byItem("queued"))).toEqual(["reviewer", "merging", "blocked", "turn"]);
    expect(facts(byItem("watching"))).toEqual(["reviewer", "watching_ci", "done", null]);
  });

  it("has a rebaser for a conflicting PR, and an integrator when that session is one", () => {
    expect(facts(byItem("rebasing"))).toEqual(["rebaser", "rebasing", "working", null]);
    expect(facts(byItem("integrate"))).toEqual(["integrator", "rebasing", "thinking", null]);
  });

  it("puts each agent at the station of its step", () => {
    const at = (id: string) => stationOf(byItem(id));
    expect(["repro", "analyze", "impl", "revise", "rebasing"].map(at)).toEqual([
      "prep",
      "prep",
      "bench",
      "bench",
      "bench",
    ]);
    expect(["review", "ci", "queued", "watching"].map(at)).toEqual([
      "review",
      "review",
      "merge",
      "ship",
    ]);
  });

  it("leaves a stuck pull request to the repair bay", () => {
    expect(agents.some((a) => a.card?.item.id === "stuck")).toBe(false);
  });

  it("adds the PM, the scout and its area reviewers, each with its session's facts", () => {
    const rest = agents.filter((a) => !a.card).map((a) => [a.key, a.role, a.status, a.area]);
    expect(rest).toEqual([
      ["pm", "pm", "working", null],
      ["scout", "scout", "working", null],
      ["area:ux", "area", "done", "ux"],
      ["area:performance", "area", "working", "performance"],
      ["area:security", "area", "blocked", "security"],
    ]);
    const plain = sceneAgents(inputs(status({ mode: "software_factory", scout: null })));
    expect(plain.map((a) => [a.key, a.role, a.status])).toEqual([["pm", "pm", "idle"]]);
    const idle = sceneAgents(inputs(status({ scout: { ...scoutStatus, phase: "idle" } })));
    expect(idle.find((a) => a.role === "scout")?.status).toBe("idle");
  });

  it("keys agents by item and role, so two items on one session never swap seats", () => {
    const twice = [
      w("a", 1, { sessionId: "s-impl", activeSessionId: "s-impl" }),
      w("b", 2, { sessionId: "s-impl", activeSessionId: "s-impl", stepSince: minutesAgo(5) }),
    ];
    const keys = sceneAgents(inputs(status({ inProgress: twice, scout: null }), sessions)).map(
      (a) => a.key,
    );
    expect(keys).toEqual(["item:a:builder", "item:b:builder", "pm"]);
  });
});

describe("pixel mode's hover card (#264)", () => {
  const card = (a: SceneAgent) => agentCard(a, NOW);

  it("says role, item with issue and PR, step, provider and model, progress, time and status", () => {
    expect(card(byItem("review"))).toEqual({
      role: "Reviewer",
      refs: "#8 · PR #59",
      title: "Item 8",
      step: "Reviewing",
      model: "Codex · gpt-6.1-sol",
      progress: "Checking the rounding",
      inStep: "10 min",
      status: "Working",
      statusKind: "working",
    });
  });

  it("has the right words for every role and step", () => {
    const rows = [
      "repro",
      "analyze",
      "impl",
      "revise",
      "asks",
      "free",
      "ci",
      "queued",
      "rebasing",
      "integrate",
      "watching",
    ].map((id) => {
      const c = card(byItem(id));
      return [id, c.role, c.step, c.status];
    });
    expect(rows).toEqual([
      ["repro", "Builder", "Reproducing", "Working"],
      ["analyze", "Builder", "Analyzing", "Thinking"],
      ["impl", "Builder", "Implementing", "Thinking"],
      ["revise", "Builder", "Revising", "Blocked: its session failed"],
      ["asks", "Builder", "Implementing", "Waiting for approval"],
      ["free", "Builder", "Implementing", "Blocked: waits for a free agent"],
      ["ci", "Reviewer", "Watching CI", "Blocked: waits for CI"],
      ["queued", "Reviewer", "Merging (number 2 in line)", "Blocked: waits its turn to merge"],
      ["rebasing", "Rebaser", "Rebasing", "Working"],
      ["integrate", "Integrator", "Rebasing", "Thinking"],
      ["watching", "Reviewer", "Watching CI", "Done"],
    ]);
  });

  it("describes the PM, the scout and an area reviewer without an item", () => {
    const of = (key: string) => card(agents.find((a) => a.key === key) as SceneAgent);
    expect(of("pm")).toMatchObject({
      role: "Project manager",
      refs: null,
      title: null,
      step: "Answering",
      model: "Claude Code · opus",
      inStep: null,
      status: "Working",
    });
    expect(of("scout")).toMatchObject({ role: "Scout", step: "Reviewing the areas (round 4)" });
    expect(of("area:performance")).toMatchObject({
      role: "Area reviewer · Performance",
      step: "Reviewing Performance",
      progress: "Profiling",
    });
    expect(of("area:security")).toMatchObject({
      model: "No session yet",
      status: "Blocked: waits for a free agent",
    });
  });

  it("names the agent's button with the card's facts", () => {
    expect(agentLabel(card(byItem("asks")))).toBe(
      "Builder, #6 Item 6, Implementing, Waiting for approval",
    );
  });

  it("measures time in the step in plain words", () => {
    expect(
      [0, 59_000, 12 * 60_000, 125 * 60_000, 120 * 60_000, 50 * 3_600_000].map(stepTime),
    ).toEqual(["under a minute", "under a minute", "12 min", "2 h 5 min", "2 h", "2 days"]);
  });
});

describe("pixel mode's labels and looks (#264)", () => {
  it("shows each agent's issue number and a glyph for its step without hovering", () => {
    expect(
      ["repro", "analyze", "revise", "review", "queued", "ci", "rebasing"].map((id) =>
        labelOf(byItem(id)),
      ),
    ).toEqual([
      { text: "1", glyph: "reproducing" },
      { text: "2", glyph: "analyzing" },
      { text: "4", glyph: "revising" },
      { text: "8", glyph: "reviewing" },
      { text: "10", glyph: "merging" },
      { text: "9", glyph: "watching_ci" },
      { text: "11", glyph: "rebasing" },
    ]);
    const roles = agents.filter((a) => !a.card).map((a) => labelOf(a).text);
    expect(roles).toEqual(["PM", "SCOUT", "UX", "PERF", "SEC"]);
  });

  it("seeds each agent's look from its session, the same every time, and dresses it by role", () => {
    expect(lookOf("s-impl", "builder")).toEqual(lookOf("s-impl", "builder"));
    const looks = Array.from({ length: 24 }, (_, i) => lookOf(`session-${i}`, "builder"));
    const distinct = new Set(
      looks.map((l) => JSON.stringify([l.skin, l.hair, l.style, l.hat, l.uniform])),
    );
    expect(distinct.size).toBeGreaterThan(16);
    // The uniform says the role: a builder and a reviewer never share one.
    const builder = new Set(looks.map((l) => l.uniform[0]));
    const reviewer = new Set(looks.map((_, i) => lookOf(`session-${i}`, "reviewer").uniform[0]));
    expect([...builder].some((c) => reviewer.has(c))).toBe(false);
  });
});
