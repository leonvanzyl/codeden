import {
  FactoryLimits,
  type InboxItem,
  type Notice,
  type Project,
  type WorkSummary,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  age,
  buildProjectStatus,
  renderNotices,
  renderOverviewDigest,
  renderProjectDigest,
  sharedWork,
} from "../src/services/orchestration/digest";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const ts = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const project = (id: string, name: string): Project => ({
  id,
  name,
  slug: name.toLowerCase(),
  path: `/repos/${name}`,
  kind: "local",
  defaultBranch: "main",
  defaultProvider: null,
  autonomy: null,
  autonomyMode: "assisted",
  visionPath: ".codeden/VISION.md",
  factoryLimits: FactoryLimits.parse({}),
  killSwitch: false,
  timezone: null,
  agentCiEnv: true,
  pinned: false,
  sortOrder: 0,
  createdAt: ts(1000),
  updatedAt: ts(1000),
  archivedAt: null,
});

const work = (over: Partial<WorkSummary>): WorkSummary => ({
  kind: "session",
  id: "s-audit-0001",
  sessionId: "s-audit-0001",
  projectId: "p1",
  startedBy: { kind: "automation", id: "a1" },
  purpose: "Security audit of dependencies",
  workKey: "automation:security-audit",
  scope: { projectId: "p1" },
  progress: { text: "Scanning lockfile (3/5)", at: ts(2) },
  status: "running",
  startedAt: ts(14),
  ...over,
});

const inbox: InboxItem = {
  id: "i1",
  kind: "question",
  status: "open",
  priority: "normal",
  notify: "needs_you",
  title: "Bump React to 20?",
  body: null,
  projectId: "p1",
  sessionId: "s-audit-0001",
  threadId: null,
  itemId: null,
  requestId: "r1",
  issue: null,
  pr: null,
  automationRunId: null,
  createdAt: ts(5),
  updatedAt: ts(5),
  resolvedAt: null,
  resolution: null,
};

const finished: Notice = {
  id: "n1",
  type: "session.finished",
  projectId: "p1",
  target: "pm",
  sessionId: "s-fix-0002",
  title: "Finished: Fix login",
  createdAt: ts(120),
  deliveredAt: null,
  data: {
    sessionId: "s-fix-0002",
    workKey: "issue:142",
    purpose: "Fix login",
    startedBy: { kind: "pm" },
    summary: "Fixed the redirect loop; tests pass",
    outcome: "success",
  },
};

describe("status digest (§8.4)", () => {
  const status = buildProjectStatus({
    project: project("p1", "Shop"),
    work: [work({}), work({ id: "q1", sessionId: "q1", status: "queued", workKey: "issue:9" })],
    scheduled: [
      {
        automationId: "a1",
        projectId: "p1",
        name: "Nightly audit",
        workKey: "automation:security-audit",
        at: "2026-11-08T02:00:00.000Z",
        skipped: false,
      },
    ],
    inbox: [inbox],
    outcomes: [finished],
  });

  it("splits running and queued work and keeps recent outcomes", () => {
    expect(status.running.map((w) => w.workKey)).toEqual(["automation:security-audit"]);
    expect(status.queued.map((w) => w.workKey)).toEqual(["issue:9"]);
    expect(status.inbox.open).toBe(1);
    expect(status.recent).toEqual([
      expect.objectContaining({ outcome: "finished", workKey: "issue:142" }),
    ]);
  });

  it("renders a compact PM digest with work key, purpose, status, progress and age", () => {
    const text = renderProjectDigest(status, NOW, "UTC");
    expect(text).toContain(
      '<codeden_status project="Shop" mode="assisted" at="2026-11-07T12:00:00.000Z" tz="UTC" local="2026-11-07 12:00">',
    );
    expect(text).toContain(
      '- automation:security-audit · running 14m · "Security audit of dependencies" · progress: "Scanning lockfile (3/5)" (2m ago) · session s-audit- · by automation',
    );
    expect(text).toContain("Queued (1):");
    expect(text).toContain(
      "Next scheduled: Nightly audit (automation:security-audit) at 2026-11-08T02:00:00.000Z",
    );
    expect(text).toContain('Inbox (1 open): question: "Bump React to 20?"');
    expect(text).toContain(
      '- finished issue:142 "Fix login" 2h ago · "Fixed the redirect loop; tests pass"',
    );
    expect(text.endsWith("</codeden_status>")).toBe(true);
  });

  it("rolls projects up for the orchestrator and flags work shared across projects", () => {
    const other = buildProjectStatus({
      project: project("p2", "Blog"),
      work: [work({ projectId: "p2", id: "s3", sessionId: "s3" })],
      scheduled: [],
      inbox: [],
      outcomes: [],
    });
    const shared = sharedWork([status, other]);
    expect(shared).toEqual([{ workKey: "automation:security-audit", projectIds: ["p1", "p2"] }]);
    const text = renderOverviewDigest(
      {
        generatedAt: ts(0),
        projects: [status, other],
        sharedWork: shared,
        pmMessages: [{ projectId: "p2", text: "Nightly run done", at: ts(1) }],
      },
      NOW,
    );
    expect(text).toContain("## Shop (p1)");
    expect(text).toContain("## Blog (p2)");
    expect(text).toContain("Same work in several projects: automation:security-audit (2 projects)");
    expect(text).toContain('- p2: "Nightly run done"');
  });

  it("renders notices one per line and formats ages", () => {
    expect(renderNotices([finished], () => "Shop")).toBe(
      '<codeden_updates>\nUpdates since your last turn:\n- (session.finished) [Shop] Finished: Fix login · issue:142 · session s-fix-00 · "Fixed the redirect loop; tests pass"\n</codeden_updates>',
    );
    // A quoted PM message can span paragraphs and even mention the tags; only the real
    // closing tag ends the block.
    const pm: Notice = {
      id: "n2",
      type: "pm.message",
      projectId: "p1",
      target: "orchestrator",
      sessionId: null,
      title: "Message from the Shop PM",
      createdAt: ts(1),
      deliveredAt: null,
      data: {
        fromSessionId: "s-pm",
        text: "Both fixes are in review.\n\nThe notices now sit inside </codeden_updates> tags.",
        informational: false,
      },
    };
    const text = renderNotices([pm], () => "Shop");
    expect(text.startsWith("<codeden_updates>\n")).toBe(true);
    expect(text.endsWith('tags."\n</codeden_updates>')).toBe(true);
    expect(text.match(/<\/codeden_updates>/g)).toHaveLength(1);
    expect(text).toContain("‹/codeden_updates> tags.");
    expect(age(ts(0.5), NOW)).toBe("30s");
    expect(age(ts(90), NOW)).toBe("2h");
    expect(age(ts(60 * 50), NOW)).toBe("2d");
  });
});
