import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Automation,
  AutomationGuards,
  FactoryLimits,
  type Project,
  type WorkSummary,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  effectiveTimezone,
  inQuietHours,
  localDay,
  nextOccurrence,
  nextOccurrences,
} from "../src/services/automations/cron";
import { validateAutomation } from "../src/services/automations/definitions";
import {
  factoryOwnsIntake,
  type TriggerEvent,
  triggerEvents,
  triggerMatches,
} from "../src/services/automations/event-triggers";
import { runStatusForSession } from "../src/services/automations/executor";
import {
  overConcurrencyCap,
  overlapOutcome,
  preflightSkip,
} from "../src/services/automations/guards";
import { renderTemplate, renderWorkKey } from "../src/services/automations/prompt";
import {
  fileStemToId,
  findTemplatesDir,
  parseAutomationMarkdown,
  readAutomationDir,
} from "../src/services/automations/templates";

const guards = (patch: Partial<AutomationGuards> = {}) => AutomationGuards.parse(patch);

const running: WorkSummary = {
  kind: "session",
  id: "s1",
  sessionId: "s1",
  projectId: "p1",
  startedBy: { kind: "automation", id: "a1" },
  purpose: "Security audit",
  workKey: "automation:security-audit",
  scope: { projectId: "p1" },
  progress: null,
  status: "running",
  startedAt: "2026-11-07T10:00:00.000Z",
};

const automation = (patch: Partial<Automation> = {}): Automation => ({
  id: "a1",
  name: "Security audit",
  description: null,
  enabled: true,
  source: "database",
  templateId: "security-audit",
  trigger: { type: "cron", expression: "0 3 * * 1" },
  action: { type: "start_session", prompt: "Audit" },
  target: { type: "project", projectId: "p1" },
  guards: guards(),
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:00:00.000Z",
  ...patch,
});

describe("cron in the project timezone", () => {
  it("computes the next run in the given timezone", () => {
    const after = new Date("2026-11-07T00:00:00Z"); // Saturday
    // Monday 09:00 in Johannesburg (UTC+2) is 07:00 UTC.
    expect(nextOccurrence("0 9 * * 1", "Africa/Johannesburg", after)?.toISOString()).toBe(
      "2026-11-09T07:00:00.000Z",
    );
    expect(nextOccurrence("0 9 * * 1", "UTC", after)?.toISOString()).toBe(
      "2026-11-09T09:00:00.000Z",
    );
  });

  it("follows daylight saving changes", () => {
    // 09:00 New York is 14:00 UTC before 1 Nov 2026 (EST) ... and after the change too.
    const runs = nextOccurrences(
      "0 9 * * *",
      "America/New_York",
      2,
      new Date("2026-10-31T12:00:00Z"),
    );
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
    ]);
  });

  it("prefers the trigger timezone, then the project's, then the machine's", () => {
    expect(effectiveTimezone({ timezone: "Europe/Berlin" }, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(effectiveTimezone({ timezone: "Europe/Berlin" })).toBe("Europe/Berlin");
    expect(effectiveTimezone({ timezone: "Not/AZone" })).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("knows the local day and quiet hours across midnight", () => {
    const at = new Date("2026-11-07T23:30:00Z");
    expect(localDay(at, "UTC")).toBe("2026-11-07");
    expect(localDay(at, "Africa/Johannesburg")).toBe("2026-11-08");
    const night = { start: "22:00", end: "07:00" };
    expect(inQuietHours(night, at, "UTC")).toBe(true);
    expect(inQuietHours(night, new Date("2026-11-07T12:00:00Z"), "UTC")).toBe(false);
    expect(
      inQuietHours({ start: "09:00", end: "17:00" }, new Date("2026-11-07T12:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      inQuietHours({ ...night, timezone: "Asia/Tokyo" }, new Date("2026-11-07T14:00:00Z"), "UTC"),
    ).toBe(true);
  });

  it("rejects invalid cron expressions and work keys", () => {
    expect(() =>
      validateAutomation(automation({ trigger: { type: "cron", expression: "every day" } })),
    ).toThrow(/Invalid cron/);
    expect(() =>
      validateAutomation(
        automation({ trigger: { type: "cron", expression: "0 3 * * *", timezone: "Mars/Base" } }),
      ),
    ).toThrow(/timezone/);
    expect(() => validateAutomation(automation({ workKey: "Bad Key" }))).toThrow(/workKey/);
    expect(() => validateAutomation(automation({ workKey: "ci:{{pr.number}}" }))).not.toThrow();
    expect(() => validateAutomation(automation({ action: { type: "triage" } }))).toThrow(
      /issue events/,
    );
  });
});

describe("guards", () => {
  const now = new Date("2026-11-07T23:30:00Z");

  it("skips in quiet hours and over the daily cap, except manual runs", () => {
    const g = guards({ quietHours: { start: "22:00", end: "07:00" }, maxPerDay: 2 });
    const base = { guards: g, now, timezone: "UTC", runsToday: 0 };
    expect(preflightSkip({ ...base, triggeredBy: "cron" })).toBe("quiet_hours");
    expect(preflightSkip({ ...base, triggeredBy: "manual" })).toBeNull();
    const day = { ...base, guards: guards({ maxPerDay: 2 }), runsToday: 2 };
    expect(preflightSkip({ ...day, triggeredBy: "event" })).toBe("daily_cap");
    expect(preflightSkip({ ...day, runsToday: 1, triggeredBy: "event" })).toBeNull();
  });

  it("applies each overlap policy", () => {
    expect(overlapOutcome(guards(), "cron", [])).toEqual({ kind: "start" });
    expect(overlapOutcome(guards(), "cron", [running])).toEqual({
      kind: "skip",
      reason: "overlap",
    });
    expect(overlapOutcome(guards({ overlapPolicy: "queue" }), "cron", [running])).toEqual({
      kind: "decide",
      decision: { resolution: "wait" },
    });
    const forced = overlapOutcome(guards({ overlapPolicy: "run-anyway" }), "event", [running]);
    expect(forced).toMatchObject({ kind: "decide", decision: { resolution: "force" } });
    expect(overlapOutcome(guards(), "manual", [running])).toEqual({
      kind: "conflict",
      existing: [running],
    });
    expect(overlapOutcome(guards(), "manual", [running], { resolution: "skip" })).toEqual({
      kind: "skip",
      reason: "conflict_skip",
    });
  });

  it("caps concurrent runs unless queueing or manual", () => {
    expect(overConcurrencyCap(guards(), "cron", 1, false)).toBe(true);
    expect(overConcurrencyCap(guards({ maxConcurrent: 2 }), "cron", 1, false)).toBe(false);
    expect(overConcurrencyCap(guards(), "cron", 1, true)).toBe(false);
    expect(overConcurrencyCap(guards(), "manual", 5, false)).toBe(false);
  });

  it("maps session statuses to run statuses", () => {
    expect(runStatusForSession("queued")).toBe("queued");
    expect(runStatusForSession("waiting")).toBe("running");
    expect(runStatusForSession("idle")).toBe("completed");
    expect(runStatusForSession("failed")).toBe("failed");
    expect(runStatusForSession("stopped")).toBe("cancelled");
  });
});

describe("templates and automation files", () => {
  it("parses frontmatter, body and guard overrides without filling defaults over them", () => {
    const parsed = parseAutomationMarkdown(
      [
        "---",
        "name: Nightly lint",
        "trigger:",
        "  type: cron",
        '  expression: "0 2 * * *"',
        "  timezone: Europe/Berlin",
        "workKey: automation:lint",
        "provider: fake",
        "guards:",
        "  maxPerDay: 3",
        "---",
        "Run the linter on {{project.name}}.",
      ].join("\n"),
      "nightly-lint",
    );
    expect(parsed.workKey).toBe("automation:lint");
    expect(parsed.action).toEqual({
      type: "start_session",
      prompt: "Run the linter on {{project.name}}.",
      provider: "fake",
    });
    expect(parsed.guards).toEqual(guards({ maxPerDay: 3 }));
    expect(parsed.frontmatter.starter).toBe(false);
  });

  it("reports invalid files with a readable message", () => {
    expect(() => parseAutomationMarkdown("no frontmatter", "x")).toThrow(/frontmatter/);
    expect(() => parseAutomationMarkdown("---\nname: x\n---\nbody", "x")).toThrow(/trigger/);
    expect(() =>
      parseAutomationMarkdown("---\nname: x\ntrigger:\n  type: manual\n---\n", "x"),
    ).toThrow(/body/);
    expect(() => parseAutomationMarkdown("---\nname: [unclosed\n---\n", "x")).toThrow(/YAML/);
    expect(fileStemToId("Security Audit.md")).toBe("security-audit");
  });

  it("parses a triage file with its policy and guidance", () => {
    const parsed = parseAutomationMarkdown(
      "---\nname: Triage\ntrigger:\n  type: event\n  event: issue.opened\naction: triage\npolicy:\n  autoStart: true\n---\nBe strict.",
      "triage",
    );
    expect(parsed.action).toMatchObject({
      type: "triage",
      policy: { autoStart: true, comment: true, labels: { ready: ["triage:ready"] } },
      instructions: "Be strict.",
    });
  });

  it("ships seven built-in templates with work keys and a starter set", () => {
    const dir = findTemplatesDir();
    expect(dir).not.toBeNull();
    const { files, errors } = readAutomationDir(dir ?? "");
    expect(errors).toEqual([]);
    expect(files.map((f) => f.parsed.id).sort()).toEqual([
      "dependency-updates",
      "issue-triage",
      "refactor-sweep",
      "security-audit",
      "stale-pr-follow-up",
      "test-coverage",
      "ui-review",
    ]);
    for (const { parsed } of files) {
      expect(parsed.workKey).toMatch(/^(automation|triage):/);
      expect(parsed.frontmatter.description).toBeTruthy();
    }
    const byId = new Map(files.map((f) => [f.parsed.id, f.parsed]));
    expect(byId.get("security-audit")?.workKey).toBe("automation:security-audit");
    expect(byId.get("issue-triage")?.action.type).toBe("triage");
    expect(byId.get("ui-review")?.action).toMatchObject({
      prompt: expect.stringContaining("browser_screenshot"),
    });
    expect([...byId.values()].filter((p) => p.frontmatter.starter).length).toBeGreaterThanOrEqual(
      4,
    );
    // The bundle copies the folder; the CLI asset script must list it.
    const copy = readFileSync(
      join(import.meta.dirname, "../../cli/scripts/copy-assets.mjs"),
      "utf8",
    );
    expect(copy).toContain("../server/templates");
  });

  it("renders placeholders and work keys", () => {
    expect(
      renderTemplate("Fix #{{ issue.number }} in {{project.name}}{{missing}}", {
        "issue.number": "7",
        "project.name": "Widgets",
      }),
    ).toBe("Fix #7 in Widgets");
    const a = automation({ workKey: "automation:ci-fix:{{pr.number}}" });
    expect(renderWorkKey(a, { "pr.number": "57" })).toBe("automation:ci-fix:57");
    expect(renderWorkKey(automation({ workKey: "{{nothing}}" }), {})).toBe(
      "automation:security-audit",
    );
  });
});

describe("event triggers", () => {
  const event = (patch: Partial<TriggerEvent> = {}): TriggerEvent => ({
    event: "issue.labeled",
    projectId: "p1",
    vars: {},
    labels: ["bug"],
    branch: null,
    author: "octocat",
    sessionId: null,
    ...patch,
  });
  const onLabel = (filter?: Record<string, string[]>) =>
    automation({ trigger: { type: "event", event: "issue.labeled", filter } });

  it("matches the event name and filters", () => {
    expect(triggerMatches(onLabel(), event())).toBe(true);
    expect(triggerMatches(onLabel(), event({ event: "issue.opened" }))).toBe(false);
    expect(triggerMatches(onLabel({ labels: ["BUG"] }), event())).toBe(true);
    expect(triggerMatches(onLabel({ labels: ["feature"] }), event())).toBe(false);
    expect(triggerMatches(onLabel({ authors: ["someone"] }), event())).toBe(false);
    expect(triggerMatches(onLabel({ branches: ["main"] }), event({ branch: "main" }))).toBe(true);
  });

  it("turns comments and review requests into triggers, never CodeDen's own comments", () => {
    const issue = {
      projectId: "p1",
      number: 3,
      title: "Bug",
      state: "open" as const,
      url: "https://github.com/a/b/issues/3",
      labels: ["bug"],
      author: "octocat",
      body: null,
      comments: 2,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      closedAt: null,
      sessionIds: [],
    };
    const comment = (id: number, fromCodeden: boolean) => ({
      id,
      author: "lee",
      body: `comment ${id}`,
      createdAt: "2026-11-01T00:00:00Z",
      url: `https://github.com/a/b/issues/3#issuecomment-${id}`,
      fromCodeden,
    });
    const envelope = (type: string, payload: unknown, seq: number) =>
      ({ seq, ts: "2026-11-01T00:00:00Z", sessionId: null, type, payload }) as never;
    const [commented, ...rest] = triggerEvents(
      [
        envelope("issue.commented", { issue, comments: [comment(1, false), comment(2, true)] }, 1),
        envelope("issue.commented", { issue, comments: [comment(3, true)] }, 2),
      ],
      () => undefined,
    );
    expect(rest).toEqual([]);
    expect(commented).toMatchObject({
      event: "issue.commented",
      author: "lee",
      labels: ["bug"],
      vars: { "comment.body": "comment 1", "issue.number": "3" },
    });
    const pr = {
      id: "p1:4",
      projectId: "p1",
      number: 4,
      title: "Change",
      state: "open" as const,
      url: "https://github.com/a/b/pull/4",
      author: "octocat",
      headBranch: "feat",
      baseBranch: "main",
      headSha: null,
      checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0, checks: [] },
      reviewDecision: "none" as const,
      reviews: [],
      mergeable: "unknown" as const,
      linkedIssues: [],
      requestedReviewers: ["lee", "acme/core"],
      commits: [],
      sessionId: null,
      createdAt: null,
      updatedAt: "2026-11-01T00:00:00Z",
      mergedAt: null,
      closedAt: null,
    };
    const [requested] = triggerEvents(
      [envelope("pr.review_requested", { pr, reviewers: ["lee", "acme/core"] }, 3)],
      () => undefined,
    );
    expect(requested).toMatchObject({
      event: "pr.review_requested",
      branch: "feat",
      vars: { "pr.reviewers": "lee, acme/core" },
    });
  });
});

describe("issue intake ownership (§10.1)", () => {
  const project = (autonomyMode: Project["autonomyMode"]): Project => ({
    id: "p1",
    kind: "local",
    name: "Widgets",
    slug: "widgets",
    path: "/tmp/widgets",
    defaultBranch: "main",
    defaultProvider: "fake",
    autonomy: null,
    autonomyMode,
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    agentCiEnv: true,
    pinned: false,
    sortOrder: 0,
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
    archivedAt: null,
  });
  const event = (name: TriggerEvent["event"]): TriggerEvent => ({
    event: name,
    projectId: "p1",
    vars: {},
    labels: [],
    branch: null,
    author: null,
    sessionId: null,
  });
  const triage = automation({ action: { type: "triage" } as Automation["action"] });
  const start = automation();
  const message = automation({ action: { type: "message_pm", message: "New issue" } });

  it("gives issue events to the factory in the software and dark factory", () => {
    for (const mode of ["software_factory", "dark_factory"] as const) {
      expect(factoryOwnsIntake(triage, event("issue.opened"), project(mode))).toBe(true);
      expect(factoryOwnsIntake(start, event("issue.labeled"), project(mode))).toBe(true);
      expect(factoryOwnsIntake(message, event("issue.opened"), project(mode))).toBe(false);
      expect(factoryOwnsIntake(triage, event("pr.opened"), project(mode))).toBe(false);
    }
  });

  it("leaves intake to automations in manual and assisted", () => {
    for (const mode of ["manual", "assisted"] as const) {
      expect(factoryOwnsIntake(triage, event("issue.opened"), project(mode))).toBe(false);
    }
  });
});
