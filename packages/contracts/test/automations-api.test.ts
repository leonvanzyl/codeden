import { describe, expect, it } from "vitest";
import {
  Automation,
  AutomationFileFrontmatter,
  AutomationGuardsPatch,
  AutomationListResponse,
  CreateAutomationRequest,
  RunAutomationResponse,
  TriageDecisionResponse,
  TriagePolicy,
  TriageReport,
  TriageReportResult,
} from "../src";
import { sampleAutomation, ts } from "./fixtures";

const run = {
  id: "run-1",
  automationId: "a1",
  projectId: "p1",
  status: "running",
  triggeredBy: "manual",
  startedBy: { kind: "automation", id: "a1" },
  purpose: "Security audit",
  workKey: "automation:security-audit",
  scope: { projectId: "p1" },
  progress: null,
  skipReason: null,
  sessionId: "s1",
  startedAt: ts,
  finishedAt: null,
  error: null,
} as const;

describe("automations API (§10)", () => {
  it("round-trips an automation with a work key and a triage policy", () => {
    const triage = Automation.parse({
      ...sampleAutomation,
      workKey: "triage:{{issue.number}}",
      trigger: { type: "event", event: "issue.opened" },
      action: { type: "triage", policy: { autoStart: true }, instructions: "Be strict" },
    });
    expect(Automation.parse(JSON.parse(JSON.stringify(triage)))).toEqual(triage);
    expect(triage.action).toMatchObject({
      policy: { autoStart: true, comment: true, labels: { duplicate: ["duplicate"] } },
    });
    expect(TriagePolicy.parse({}).autoStart).toBe(false);
  });

  it("keeps guard patches sparse", () => {
    expect(AutomationGuardsPatch.parse({ maxPerDay: 2 })).toEqual({ maxPerDay: 2 });
    const fm = AutomationFileFrontmatter.parse({
      name: "Audit",
      trigger: { type: "cron", expression: "0 3 * * 1" },
      guards: { overlapPolicy: "queue" },
    });
    expect(fm).toMatchObject({
      action: "start_session",
      starter: false,
      guards: { overlapPolicy: "queue" },
    });
    expect(fm.guards).not.toHaveProperty("maxConcurrent");
  });

  it("requires a template or a full definition to create", () => {
    expect(CreateAutomationRequest.safeParse({ templateId: "security-audit" }).success).toBe(true);
    expect(CreateAutomationRequest.safeParse({ name: "x" }).success).toBe(false);
    const full = CreateAutomationRequest.parse({
      name: "x",
      trigger: { type: "manual" },
      action: { type: "message_pm", message: "hi" },
    });
    expect(full.enabled).toBe(false);
  });

  it("round-trips run results, list responses and triage shapes", () => {
    for (const value of [
      { status: "started", run, sessionId: "s1" },
      { status: "queued", run: { ...run, status: "queued" }, sessionId: "s1", behind: ["s0"] },
      {
        status: "skipped",
        run: { ...run, status: "skipped", skipReason: "overlap", sessionId: null },
      },
      { status: "joined", sessionId: "s1" },
    ]) {
      expect(RunAutomationResponse.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    const list = AutomationListResponse.parse({
      automations: [
        {
          automation: sampleAutomation,
          states: [
            {
              projectId: "p1",
              enabled: false,
              enabledOverride: null,
              paused: false,
              nextRunAt: ts,
              skipNextAt: null,
            },
          ],
          lastRun: run,
          path: null,
          readOnly: false,
        },
      ],
      errors: [{ path: "/x.md", message: "Missing YAML frontmatter" }],
    });
    expect(list.automations[0]?.states[0]?.nextRunAt).toBe(ts);
    expect(
      TriageReport.safeParse({ issueNumber: 1, decision: "maybe", summary: "x" }).success,
    ).toBe(false);
    expect(
      TriageDecisionResponse.parse({
        item: {
          id: "triage:p1:1",
          kind: "triage",
          status: "dismissed",
          title: "Should I take this on? #1",
          body: null,
          projectId: "p1",
          sessionId: null,
          threadId: null,
          itemId: null,
          requestId: null,
          issue: { number: 1, url: "https://github.com/a/b/issues/1" },
          pr: null,
          automationRunId: null,
          createdAt: ts,
          updatedAt: ts,
          resolvedAt: ts,
          resolution: { decision: "decline" },
        },
        start: null,
      }).start,
    ).toBeNull();
    const work = {
      kind: "session",
      id: "s1",
      sessionId: "s1",
      projectId: "p1",
      startedBy: { kind: "automation", id: "factory" },
      purpose: "Resolve #1",
      workKey: "issue:1",
      scope: { projectId: "p1" },
      progress: null,
      status: "running",
      startedAt: ts,
    };
    const running = { status: "already_running", existing: [work] };
    expect(TriageReportResult.parse(running)).toEqual(running);
    expect(TriageReportResult.safeParse({ status: "already_running", existing: [] }).success).toBe(
      false,
    );
  });
});
