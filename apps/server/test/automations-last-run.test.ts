import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutomationRun,
  type AutomationRunStatus,
  FactoryLimits,
  type Project,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { AutomationService } from "../src/services/automations/automation-service";
import { InboxService } from "../src/services/inbox-service";
import { ProjectService } from "../src/services/projects/project-service";
import { SettingsStore } from "../src/settings-store";
import { removeTree } from "./support/remove-tree";

/**
 * Issue #605: an automation for all projects lists the latest run of the project being
 * viewed, never another project's. The unscoped list keeps the newest run across projects.
 */
describe("an automation's last run in the list (#605)", () => {
  let dir: string;
  let db: Database;
  let automations: AutomationService;
  let id: string;

  const project = (pid: string, name: string): Project => {
    const at = "2026-01-01T00:00:00.000Z";
    return {
      id: pid,
      kind: "local",
      name,
      slug: name.toLowerCase(),
      path: join(dir, name),
      defaultBranch: "main",
      defaultProvider: null,
      autonomy: null,
      autonomyMode: "assisted",
      visionPath: ".codeden/VISION.md",
      factoryLimits: FactoryLimits.parse({}),
      killSwitch: false,
      timezone: "UTC",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    } as Project;
  };

  const run = (
    projectId: string,
    startedAt: string,
    status: AutomationRunStatus = "completed",
  ): AutomationRun =>
    automations.runs.save({
      id: `${projectId}-${startedAt}`,
      automationId: id,
      projectId,
      status,
      triggeredBy: "manual",
      startedBy: { kind: "user" },
      purpose: "Weekly notes",
      workKey: "automation:weekly-notes",
      scope: { projectId },
      progress: null,
      skipReason: null,
      sessionId: null,
      issueNumber: null,
      startedAt,
      finishedAt: status === "completed" || status === "failed" ? startedAt : null,
      error: status === "failed" ? { message: "boom" } : null,
    });

  const lastRun = (projectId?: string) =>
    automations.list(projectId).automations.find((i) => i.automation.id === id)?.lastRun;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-automation-last-run-"));
    db = openDatabase(join(dir, "codeden.db"));
    const store = new EventStore(db.db);
    const projects = new ProjectService({
      db: db.db,
      store,
      exec: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        notFound: false,
        timedOut: false,
        path: null,
      }),
      projectsDir: dir,
    });
    for (const p of [project("pa", "Alpha"), project("pb", "Bravo"), project("pc", "Charlie")]) {
      store.append([{ type: "project.created", sessionId: null, payload: { project: p } }]);
    }
    automations = new AutomationService({
      db: db.db,
      store,
      settings: new SettingsStore(join(dir, "settings.json")),
      projects,
      sessions: {} as never,
      repo: {} as never,
      inbox: new InboxService(db.db, store, () => async () => {}),
      orchestration: () => ({}) as never,
      github: {} as never,
      home: join(dir, "home"),
      rescanMs: 0,
    });
    automations.sources.reload();
    id = automations.definitions.create({
      name: "Weekly notes",
      trigger: { type: "manual" },
      action: { type: "message_pm", message: "Write the weekly notes." },
      enabled: false,
    }).id;
  });

  afterEach(async () => {
    automations.stop();
    db.close();
    await removeTree(dir);
  });

  it("shows each project its own newest run, even when another project ran it later", () => {
    run("pa", "2026-03-01T09:00:00.000Z", "failed");
    run("pa", "2026-03-02T09:00:00.000Z");
    run("pb", "2026-03-01T10:00:00.000Z");
    run("pb", "2026-03-05T10:00:00.000Z", "failed");

    expect(lastRun("pa")).toMatchObject({
      projectId: "pa",
      status: "completed",
      startedAt: "2026-03-02T09:00:00.000Z",
    });
    expect(lastRun("pb")).toMatchObject({
      projectId: "pb",
      status: "failed",
      startedAt: "2026-03-05T10:00:00.000Z",
    });
  });

  it("gives a project that never ran it no last run, whoever else did", () => {
    run("pa", "2026-03-02T09:00:00.000Z");
    expect(lastRun("pc")).toBeNull();
  });

  it("keeps the newest run across projects in the list of every project", () => {
    expect(lastRun()).toBeNull();
    run("pa", "2026-03-02T09:00:00.000Z");
    run("pb", "2026-03-05T10:00:00.000Z");
    run("pa", "2026-03-03T09:00:00.000Z");
    expect(lastRun()).toMatchObject({ projectId: "pb", startedAt: "2026-03-05T10:00:00.000Z" });
  });
});
