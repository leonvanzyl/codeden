import {
  AutomationRun,
  FactoryLimits,
  type GithubIssue,
  InboxItem,
  Project,
  type Role,
  TriageDecisionResponse,
  TriageReportResult,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const ts = "2026-11-07T10:00:00.000Z";
const GH = "p-gh";

function issue(number: number): GithubIssue {
  return {
    projectId: GH,
    number,
    title: `Bug ${number}`,
    state: "open",
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    author: "octocat",
    body: "Something is broken",
    comments: 0,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    sessionIds: [],
  };
}

describe("issue triage (§10)", () => {
  let h: Harness;
  let project: Project;
  const triageId = `starter:${GH}:issue-triage`;
  const report = async (args: Record<string, unknown>) => {
    const res = await h.server.services.tools.call("report_triage", args, {
      role: "pm" as Role,
      sessionId: "pm-test",
      projectId: GH,
      caller: "mcp",
      signal: new AbortController().signal,
    });
    if (res.isError) throw new Error(res.text);
    return TriageReportResult.parse(JSON.parse(res.text));
  };

  beforeAll(async () => {
    h = await startHarness({
      orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 } },
      github: { sync: false },
      automations: { rescanMs: 0 },
      factory: { autoTick: false },
    });
    project = {
      id: GH,
      kind: "github",
      name: "Widgets",
      slug: "widgets",
      path: h.repo,
      defaultBranch: "main",
      defaultProvider: "fake",
      autonomy: null,
      autonomyMode: "assisted",
      visionPath: ".codeden/VISION.md",
      factoryLimits: FactoryLimits.parse({}),
      killSwitch: false,
      timezone: null,
      pinned: false,
      sortOrder: 0,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      github: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
        defaultBranch: "main",
      },
    };
    h.server.services.store.append([
      { type: "project.created", sessionId: null, payload: { project: Project.parse(project) } },
    ]);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("offers triage in the GitHub project's starter set and hands new issues to the PM", async () => {
    await waitUntil(() => h.server.services.automations.definitions.find(triageId));
    expect(h.server.services.automations.definitions.get(triageId).enabled).toBe(false);
    expect((await h.api("POST", `/automations/${triageId}/enable`, {})).status).toBe(200);

    h.server.services.store.append([
      { type: "issue.opened", sessionId: null, payload: { issue: issue(42) } },
    ]);
    const run = await waitUntil(async () => {
      const runs = AutomationRun.array().parse(
        (await h.api("GET", `/automations/runs?automationId=${triageId}`)).body,
      );
      return runs[0];
    });
    const pm = h.server.services.orchestration.roles.find("pm", GH);
    // Handing the issue to the PM is not the end of the run: it waits for report_triage.
    expect(run).toMatchObject({
      status: "running",
      triggeredBy: "event",
      workKey: "triage:42",
      sessionId: pm?.id,
      issueNumber: 42,
      purpose: "Issue triage #42",
    });
  });

  it("asks the user about ready issues and starts a session on accept", async () => {
    const result = await report({ issueNumber: 42, decision: "ready", summary: "Clear bug." });
    expect(result).toEqual({ status: "inbox", inboxItemId: `triage:${GH}:42` });
    const runs = AutomationRun.array().parse(
      (await h.api("GET", `/automations/runs?automationId=${triageId}`)).body,
    );
    expect(runs[0]).toMatchObject({
      status: "completed",
      issueNumber: 42,
      progress: { text: "Triaged as ready" },
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    const item = InboxItem.parse(h.server.services.inbox.get(`triage:${GH}:42`));
    expect(item).toMatchObject({
      kind: "triage",
      status: "open",
      title: "Should I take this on? #42 Bug 42",
      issue: { number: 42 },
    });
    const accepted = TriageDecisionResponse.parse(
      (await h.api("POST", `/automations/triage/${item.id}/accept`, {})).body,
    );
    expect(accepted.item.status).toBe("resolved");
    expect(accepted.start?.status).toBe("started");
    const sessionId = accepted.start?.status === "started" ? accepted.start.sessionId : "";
    expect((await h.detail(sessionId)).session).toMatchObject({
      workKey: "issue:42",
      issue: { number: 42 },
      startedBy: { kind: "user" },
    });
  });

  it("records other decisions, declines, and auto-starts when the policy allows", async () => {
    expect(await report({ issueNumber: 43, decision: "needs_info", summary: "No repro." })).toEqual(
      {
        status: "recorded",
      },
    );
    const asked = await report({ issueNumber: 44, decision: "ready", summary: "Small fix." });
    const declined = TriageDecisionResponse.parse(
      (
        await h.api("POST", `/automations/triage/triage:${GH}:44/decline`, {
          reason: "Not now",
        })
      ).body,
    );
    expect(asked.status).toBe("inbox");
    expect(declined).toMatchObject({ item: { status: "dismissed" }, start: null });

    await h.api("PATCH", `/automations/${triageId}`, {
      action: { type: "triage", policy: { autoStart: true } },
    });
    const auto = await report({ issueNumber: 45, decision: "ready", summary: "Typo." });
    expect(auto).toMatchObject({ status: "started", start: { status: "started" } });
  });

  it("leaves issue intake to the factory loop in the software and dark factory (§10.1)", async () => {
    const runsOf = async () =>
      AutomationRun.array().parse(
        (await h.api("GET", `/automations/runs?automationId=${triageId}`)).body,
      );
    const before = (await runsOf()).length;
    for (const autonomyMode of ["software_factory", "dark_factory"] as const) {
      h.server.services.store.append([
        {
          type: "project.updated",
          sessionId: null,
          payload: { project: Project.parse({ ...project, autonomyMode }) },
        },
      ]);
      const number = autonomyMode === "software_factory" ? 50 : 51;
      h.server.services.store.append([
        { type: "issue.opened", sessionId: null, payload: { issue: issue(number) } },
      ]);
      const run = await waitUntil(async () =>
        (await runsOf()).find((r) => r.workKey === `triage:${number}`),
      );
      expect(run).toMatchObject({ status: "skipped", skipReason: "factory_intake" });
    }
    // Skipped before the executor runs: the PM is never handed these issues by the automation.
    expect((await runsOf()).length).toBe(before + 2);
    h.server.services.store.append([
      { type: "project.updated", sessionId: null, payload: { project: Project.parse(project) } },
    ]);
  });
});
