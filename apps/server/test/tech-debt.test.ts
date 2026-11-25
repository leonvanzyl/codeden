import { afterEach, describe, expect, it, vi } from "vitest";
import { type ToolCaller, ToolRegistry } from "../src/mcp/registry";
import { listTechDebt } from "../src/mcp/tools/tech-debt";
import { techDebtIssuePort } from "../src/services/tech-debt/issue";
import { TechDebtService } from "../src/services/tech-debt/service";
import { createGithubEnv } from "./support/github-env";

const issue = "owner/repo#246";
const date = "2026-11-23T00:00:00.000Z";
const low =
  "- [ ] LOW `src/build.ts:12` — Use the shared helper. | Receipt: review-1 | Date: 2026-11-23 | PR: #42";
const medium = "- [ ] MEDIUM `src/build.ts:20` — Reproduce the failure.";

describe("project tech debt", () => {
  const envs: ReturnType<typeof createGithubEnv>[] = [];
  afterEach(async () => {
    for (const env of envs.splice(0)) await env.close();
  });

  function setup() {
    const env = createGithubEnv();
    envs.push(env);
    let body = `## Review\r\n${low}\r\n${medium}\r\n`;
    const read = vi.fn(async () => ({ body, date }));
    const write = vi.fn(async (_issue: string, next: string) => {
      body = next;
    });
    const start = vi.fn(async () => "fix-session");
    const service = new TechDebtService(env.db.db, env.store, { read, write }, start);
    return {
      env,
      service,
      project: env.githubProject,
      local: env.localProject,
      read,
      write,
      start,
    };
  }

  it("imports LOW findings once on concurrent first loads and syncs only their ticks", async () => {
    const { service, project, read, write } = setup();
    await service.act(project, { action: "configure", issue });
    const [a, b] = await Promise.all([service.list(project), service.list(project)]);
    expect(a).toEqual(b);
    expect(read).toHaveBeenCalledExactlyOnceWith(issue);
    expect(a.findings).toMatchObject([
      {
        location: "src/build.ts:12",
        text: "Use the shared helper.",
        receipt: "review-1",
        date,
        pr: "#42",
        status: "open",
      },
    ]);
    const id = a.findings[0]?.id ?? "";
    await expect(service.act(project, { action: "dismiss", id, reason: " " })).rejects.toThrow();
    await service.act(project, {
      action: "dismiss",
      id,
      reason: "Superseded by the shared implementation.",
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      issue,
      `## Review\r\n${low.replace("[ ]", "[x]")}\r\n${medium}\r\n`,
    );
    expect((await service.list(project)).findings[0]).toMatchObject({
      status: "dismissed",
      reason: "Superseded by the shared implementation.",
    });
  });

  it.each(["unreachable", "edited", "removed", "changed during sync", "write rejected"] as const)(
    "commits a local closure when the tracking issue is %s",
    async (failure) => {
      const { env, service, project, read, write } = setup();
      await service.act(project, { action: "configure", issue });
      const { findings } = await service.list(project);
      const id = findings[0]?.id ?? "";
      const reason = "Superseded by the shared implementation.";
      const action =
        failure === "unreachable" || failure === "removed"
          ? ({ action: "fixed", id } as const)
          : ({ action: "dismiss", id, reason } as const);
      const finalFinding = {
        id,
        status: action.action === "fixed" ? "fixed" : "dismissed",
        reason: action.action === "fixed" ? null : reason,
      };
      let lastEventAtRead: (typeof env.events)[number] | undefined;
      read.mockImplementationOnce(async () => {
        lastEventAtRead = env.events.at(-1);
        if (failure === "unreachable") throw new Error("Issue unavailable");
        const body = {
          edited: low.replace("shared helper", "new helper"),
          removed: medium,
          "changed during sync": low,
          "write rejected": low,
        }[failure];
        return { body, date };
      });
      if (failure === "changed during sync") {
        read.mockResolvedValueOnce({ body: `${low}\n${medium}`, date });
      }
      if (failure === "write rejected") {
        read.mockResolvedValueOnce({ body: low, date });
        write.mockRejectedValueOnce(new Error("Write rejected"));
      }

      expect(await service.act(project, action)).toMatchObject({
        findings: [finalFinding],
        syncError: expect.any(String),
      });
      expect(lastEventAtRead).toMatchObject({
        type: "tech_debt.updated",
        payload: { view: { findings: [finalFinding] } },
      });
      expect((await service.list(project)).findings).toMatchObject([finalFinding]);
      expect(write).toHaveBeenCalledTimes(failure === "write rejected" ? 1 : 0);
    },
  );

  it("imports new LOW entries when saving the same issue and preserves existing findings by ID", async () => {
    const { service, project, read } = setup();
    await service.act(project, { action: "configure", issue });
    const { findings } = await service.list(project);
    const id = findings[0]?.id ?? "";
    await service.act(project, { action: "dismiss", id, reason: "Superseded." });
    read.mockResolvedValueOnce({
      body: `${low.replace("[ ]", "[x]")}\n- [ ] LOW src/check.ts:3 — Reuse the validator.`,
      date: "2026-11-23T00:00:00Z",
    });
    await service.act(project, { action: "configure", issue });

    expect((await service.list(project)).findings).toMatchObject([
      { id, status: "dismissed", reason: "Superseded." },
      { location: "src/check.ts:3", status: "open", date: "2026-11-23T00:00:00Z" },
    ]);
  });

  it("keeps local findings project-scoped and starts a normal fix before changing status", async () => {
    const { service, local, project, read, write, start } = setup();
    const finding = {
      location: "src/local.ts:5",
      text: "Document the invariant.",
      receipt: "local-review",
      date,
      pr: null,
    };
    const added = await service.act(local, { action: "record", finding });
    const id = added.findings[0]?.id ?? "";
    await expect(service.act(project, { action: "fix", ids: [id] })).rejects.toThrow();
    start.mockRejectedValueOnce(new Error("runner unavailable"));
    await expect(service.act(local, { action: "fix", ids: [id] })).rejects.toThrow(
      "runner unavailable",
    );
    expect((await service.list(local)).findings[0]?.status).toBe("open");
    const started = await service.act(local, { action: "fix", ids: [id] });
    expect(started.findings[0]).toMatchObject({ status: "in_progress", sessionId: "fix-session" });
    expect(start).toHaveBeenLastCalledWith(local, [expect.objectContaining(finding)]);
    await service.act(local, { action: "fixed", id });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["failed", "stopped", "completed"] as const)(
    "reopens a finding after its fix session goes %s without ticking the issue",
    async (status) => {
      const { env, service, project, start, write } = setup();
      await service.act(project, { action: "configure", issue });
      const { findings } = await service.list(project);
      const id = findings[0]?.id ?? "";
      const fix = { action: "fix" as const, ids: [id] };
      const session = env.addSession({
        id: "fix-session",
        projectId: project.id,
        status: "running",
      });
      await service.act(project, fix);
      expect((await service.list(project)).findings[0]).toMatchObject({
        status: "in_progress",
        sessionId: session.id,
      });
      await expect(service.act(project, fix)).rejects.toThrow();
      expect(start).toHaveBeenCalledTimes(1);

      env.store.append([
        {
          type: "session.updated",
          sessionId: session.id,
          payload: { session: { ...session, status } },
        },
      ]);
      expect((await service.list(project)).findings[0]).toMatchObject({
        status: "open",
        sessionId: null,
      });
      start.mockResolvedValueOnce("retry-session");
      expect((await service.act(project, fix)).findings[0]).toMatchObject({
        status: "in_progress",
        sessionId: "retry-session",
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(["idle", "interrupted"] as const)(
    "keeps a finding in progress while its fix session is %s and resumable",
    async (status) => {
      const { env, service, project, start } = setup();
      await service.act(project, { action: "configure", issue });
      const { findings } = await service.list(project);
      const fix = { action: "fix" as const, ids: [findings[0]?.id ?? ""] };
      const session = env.addSession({ id: "fix-session", projectId: project.id, status });
      await service.act(project, fix);
      expect((await service.list(project)).findings[0]).toMatchObject({
        status: "in_progress",
        sessionId: session.id,
      });
      await expect(service.act(project, fix)).rejects.toThrow("Select open findings");
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

  it("lets Fix selected start again after a failed fix run and refuses while either run is active", async () => {
    const { env, service, project, start } = setup();
    await service.act(project, { action: "configure", issue });
    const { findings } = await service.list(project);
    const fix = { action: "fix" as const, ids: [findings[0]?.id ?? ""] };
    const first = env.addSession({ id: "fix-session", projectId: project.id, status: "running" });

    expect((await service.act(project, fix)).findings[0]).toMatchObject({
      status: "in_progress",
      sessionId: first.id,
    });
    await expect(service.act(project, fix)).rejects.toThrow("Select open findings");
    expect(start).toHaveBeenCalledTimes(1);

    env.store.append([
      {
        type: "session.updated",
        sessionId: first.id,
        payload: { session: { ...first, status: "failed" } },
      },
    ]);
    start.mockImplementationOnce(
      async () =>
        env.addSession({ id: "retry-session", projectId: project.id, status: "running" }).id,
    );
    expect((await service.act(project, fix)).findings[0]).toMatchObject({
      status: "in_progress",
      sessionId: "retry-session",
    });
    await expect(service.act(project, fix)).rejects.toThrow("Select open findings");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("syncs a closed local finding to a configured issue without duplicating it on reimport", async () => {
    const { service, project, write } = setup();
    await service.act(project, { action: "configure", issue });
    const recorded = await service.act(project, {
      action: "record",
      finding: { location: "src/local.ts:5", text: "Local.", receipt: null, date, pr: null },
    });
    const id = recorded.findings[0]?.id ?? "";
    await service.act(project, { action: "fixed", id });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      issue,
      expect.stringContaining("- [x] LOW `src/local.ts:5`"),
    );
    expect((await service.list(project)).findings.map((finding) => finding.id)).toEqual([
      id,
      expect.not.stringMatching(id),
    ]);
  });

  it("imports from the configured repository through the fake GitHub client", async () => {
    const { env, project, start } = setup();
    const remote = env.gh.addIssue({ body: low });
    const target = `${env.gh.owner}/${env.gh.repo}#${remote.number}`;
    const service = new TechDebtService(
      env.db.db,
      env.store,
      techDebtIssuePort(env.service.client),
      start,
    );
    await service.act(project, { action: "configure", issue: target });
    const view = await service.list(project);
    expect(view.findings).toMatchObject([
      { source: target, status: "open", text: "Use the shared helper." },
    ]);
  });

  it("limits the PM tool to its own project and lets the orchestrator select a project", async () => {
    const { service, local, project } = setup();
    const tools = new ToolRegistry([listTechDebt], {
      techDebt: service,
      projects: { get: (id: string) => (id === local.id ? local : project) },
    } as never);
    const caller: ToolCaller = {
      role: "pm",
      projectId: local.id,
      sessionId: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    };
    expect(tools.list("agent")).toEqual([]);
    expect(await tools.call("list_tech_debt", { projectId: project.id }, caller)).toMatchObject({
      isError: true,
    });
    const own = await tools.call("list_tech_debt", {}, caller);
    expect(JSON.parse(own.text)).toMatchObject({ projectId: local.id });
    const selected = await tools.call(
      "list_tech_debt",
      { projectId: project.id },
      { ...caller, role: "orchestrator", projectId: null },
    );
    expect(JSON.parse(selected.text)).toMatchObject({ projectId: project.id });
  });

  it("retains local records during an import failure and retries the import", async () => {
    const { service, project, read } = setup();
    await service.act(project, {
      action: "record",
      finding: { location: "src/local.ts:5", text: "Local.", receipt: null, date, pr: null },
    });
    await service.act(project, { action: "configure", issue });
    read.mockRejectedValueOnce(new Error("Issue unavailable"));
    expect(await service.list(project)).toMatchObject({
      imported: false,
      importError: "Issue unavailable",
      findings: [{ text: "Local." }],
    });
    expect((await service.list(project)).findings).toHaveLength(2);
  });
});
