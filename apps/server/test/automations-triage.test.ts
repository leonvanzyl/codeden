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
import { FakeFactoryGithub } from "./support/fake-factory-github";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const ts = "2026-11-07T10:00:00.000Z";
const GH = "p-gh";

function issue(number: number, author = "octocat"): GithubIssue {
  return {
    projectId: GH,
    number,
    title: `Bug ${number}`,
    state: "open",
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    author,
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
  // Its viewer, "codeden", is the account CodeDen uses on GitHub.
  const github = new FakeFactoryGithub();
  const triageId = `starter:${GH}:issue-triage`;
  /** An issue the sync already knows (imported: no triage run, no PM notice). */
  const synced = (i: GithubIssue) =>
    h.server.services.store.append([
      { type: "issue.updated", sessionId: null, payload: { issue: i, changes: ["imported"] } },
    ]);
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
      factory: { autoTick: false, github },
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
      agentCiEnv: true,
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
  });
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
    synced(issue(45, "codeden"));
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

  it("never auto-starts a session for an issue by an untrusted author (#86)", async () => {
    await h.api("PATCH", `/automations/${triageId}`, {
      action: { type: "triage", policy: { autoStart: true } },
    });
    // On a public repository anyone can open an issue; "stranger" is not a trusted author.
    h.server.services.store.append([
      {
        type: "issue.opened",
        sessionId: null,
        payload: { issue: { ...issue(46), author: "stranger" } },
      },
    ]);
    const result = await report({ issueNumber: 46, decision: "ready", summary: "Looks easy." });
    // A person decides whether a stranger's issue becomes an agent session.
    expect(result).toEqual({ status: "inbox", inboxItemId: `triage:${GH}:46` });
    expect(h.server.services.inbox.get(`triage:${GH}:46`)).toMatchObject({
      kind: "triage",
      status: "open",
      body: expect.stringContaining("@stranger, who has no write access to the repository"),
    });
  });

  it("auto-starts for people with write access and the project's trusted authors (#86)", async () => {
    github.associations.set(47, "collaborator");
    synced(issue(47, "maintainer"));
    const collaborator = await report({ issueNumber: 47, decision: "ready", summary: "Small." });
    expect(collaborator).toMatchObject({ status: "started", start: { status: "started" } });

    h.server.services.store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: {
          project: Project.parse({
            ...project,
            factoryLimits: FactoryLimits.parse({ trustedAuthors: ["Alice"] }),
          }),
        },
      },
    ]);
    synced(issue(48, "alice"));
    const listed = await report({ issueNumber: 48, decision: "ready", summary: "Small." });
    expect(listed).toMatchObject({ status: "started", start: { status: "started" } });
    h.server.services.store.append([
      { type: "project.updated", sessionId: null, payload: { project: Project.parse(project) } },
    ]);
  });
});
