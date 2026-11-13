import {
  AUTOMATION_IMPORT_LIMITS,
  AutomationExport,
  AutomationImportPreviewResponse,
  type AutomationListItem,
  AutomationListResponse,
  ExportAutomationsResponse,
  ImportAutomationsResponse,
} from "@codeden/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { automationRoutes } from "../src/routes/automations";
import { collectImportFiles, previewFile } from "../src/services/automations/import";
import { automationToMarkdown, exportFileName } from "../src/services/automations/markdown";
import { pmChangeInboxId } from "../src/services/automations/pm-change-notice";
import { findTemplatesDir, readAutomationDir } from "../src/services/automations/templates";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const RELEASE_NOTES = [
  "---",
  "name: Release notes draft",
  "description: Drafts release notes every Friday.",
  "trigger:",
  "  type: cron",
  '  expression: "0 16 * * 5"',
  "  timezone: Europe/London",
  "action: start_session",
  'workKey: "automation:release-notes"',
  "provider: claude",
  "effort: medium",
  "autonomy: read_only",
  "guards:",
  "  maxPerDay: 1",
  "---",
  "Draft the release notes for {{project.name}} ({{date}}).",
].join("\n");

const zipOf = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  ).toString("base64");

describe("the automation file format: export and parse back", () => {
  it("round-trips every built-in template through export", () => {
    const dir = findTemplatesDir();
    if (!dir) throw new Error("templates folder not found");
    const { files, errors } = readAutomationDir(dir);
    expect(errors).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
    for (const { parsed } of files) {
      expect(parsed.unknownFields, parsed.id).toEqual([]);
      const draft = {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description ?? null,
        trigger: parsed.frontmatter.trigger,
        action: parsed.action,
        guards: parsed.guards,
        workKey: parsed.workKey,
      };
      const back = previewFile({ name: `${parsed.id}.md`, content: automationToMarkdown(draft) });
      expect(back.error, parsed.id).toBeNull();
      expect(back.automation, parsed.id).toEqual(draft);
    }
  });

  it("quotes placeholders and keeps message and triage bodies", () => {
    const md = automationToMarkdown({
      name: "Fix CI",
      description: null,
      trigger: { type: "event", event: "pr.checks_failed", filter: { branches: ["main"] } },
      action: { type: "start_session", prompt: "Fix #{{pr.number}}", title: "{{pr.title}}" },
      guards: {
        overlapPolicy: "queue",
        maxConcurrent: 2,
        maxPerDay: null,
        quietHours: null,
        catchUpMissed: false,
      },
      workKey: "automation:ci-fix:{{pr.number}}",
    });
    expect(md).toContain("workKey: automation:ci-fix:{{pr.number}}");
    expect(md).toContain('title: "{{pr.title}}"');
    expect(md).toContain("overlapPolicy: queue");
    expect(md).not.toContain("catchUpMissed");
    const back = previewFile({ name: "fix-ci.md", content: md });
    expect(back.automation?.action).toEqual({
      type: "start_session",
      prompt: "Fix #{{pr.number}}",
      title: "{{pr.title}}",
    });
    expect(exportFileName({ name: "Fix CI!" })).toBe("fix-ci.md");
  });
});

describe("import validation", () => {
  it("previews a valid file and flags Full permissions", () => {
    const ok = previewFile({ name: "release.md", content: RELEASE_NOTES });
    expect(ok.error).toBeNull();
    expect(ok.fullPermissions).toBe(false);
    expect(ok.automation?.action).toMatchObject({ autonomy: "read_only", effort: "medium" });
    const full = previewFile({
      name: "r.md",
      content: RELEASE_NOTES.replace("read_only", "full"),
    });
    expect(full.fullPermissions).toBe(true);
  });

  it("explains bad YAML, unknown fields, invalid cron and missing frontmatter", () => {
    const error = (content: string) => previewFile({ name: "x.md", content }).error;
    expect(error("no frontmatter")).toMatch(/frontmatter/);
    expect(error("---\nname: [unclosed\n---\nbody")).toMatch(/Invalid YAML/);
    expect(error(RELEASE_NOTES.replace("effort: medium", "effort: medium\ncolour: blue"))).toBe(
      "Unknown field: colour",
    );
    expect(error(RELEASE_NOTES.replace("  maxPerDay: 1", "  maxPerDya: 1\n  extra: 2"))).toBe(
      "Unknown fields: guards.maxPerDya, guards.extra",
    );
    expect(error(RELEASE_NOTES.replace("0 16 * * 5", "every friday"))).toMatch(/cron/);
    expect(error(RELEASE_NOTES.replace("read_only", "yolo"))).toMatch(/autonomy/);
    expect(error(RELEASE_NOTES.replace("Europe/London", "Mars/Olympus"))).toMatch(/timezone/);
  });

  it("collects files, zip entries and pasted text with unique names", () => {
    const files = collectImportFiles({
      files: [{ name: "C:\\Users\\me\\release.md", content: RELEASE_NOTES }],
      zipBase64: zipOf({
        "shared/release.md": RELEASE_NOTES,
        "shared/readme.txt": "ignored",
        "__MACOSX/shared/._release.md": "junk",
      }),
      text: RELEASE_NOTES,
    });
    expect(files.map((f) => f.name)).toEqual([
      "release.md",
      "release (2).md",
      "release-notes-draft.md",
    ]);
  });

  it("refuses too many files, oversized files and zips before parsing", () => {
    const many = Array.from({ length: AUTOMATION_IMPORT_LIMITS.maxFiles + 1 }, (_, i) => [
      `a${i}.md`,
      RELEASE_NOTES,
    ]);
    expect(() => collectImportFiles({ zipBase64: zipOf(Object.fromEntries(many)) })).toThrow(
      /At most/,
    );
    const big = `${RELEASE_NOTES}\n${"x".repeat(AUTOMATION_IMPORT_LIMITS.maxFileChars)}`;
    expect(() => collectImportFiles({ zipBase64: zipOf({ "big.md": big }) })).toThrow(
      /larger than/,
    );
    const entries = Object.fromEntries(
      Array.from({ length: AUTOMATION_IMPORT_LIMITS.maxZipEntries + 1 }, (_, i) => [
        `f${i}.txt`,
        "x",
      ]),
    );
    expect(() => collectImportFiles({ zipBase64: zipOf(entries) })).toThrow(/entries/);
    expect(() => collectImportFiles({ zipBase64: Buffer.from("nope").toString("base64") })).toThrow(
      /zip/,
    );
    expect(() => collectImportFiles({ zipBase64: zipOf({ "notes.txt": "x" }) })).toThrow(/No .md/);
  });
});

describe("automations API: create, duplicate, export and import", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(
      { automations: { rescanMs: 0 }, github: { sync: false } },
      { ".codeden/automations/release-notes.md": RELEASE_NOTES },
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  const list = async () =>
    AutomationListResponse.parse(
      (await h.api("GET", `/automations?projectId=${h.projectId}`)).body,
    );
  const pmTool = async (name: string, args: unknown) =>
    h.server.services.tools.call(name, args, {
      role: "pm",
      sessionId: "pm-test",
      projectId: h.projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });

  it("creates from scratch off, validates, and updates any field", async () => {
    const res = await h.api("POST", "/automations", {
      projectId: h.projectId,
      name: "Weekday check",
      trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Amsterdam" },
      action: { type: "start_session", prompt: "Check {{project.name}}", autonomy: "read_only" },
    });
    expect(res.status).toBe(201);
    const item = res.body as AutomationListItem;
    expect(item.automation).toMatchObject({ enabled: false, source: "database" });
    expect(item.automation.createdBy).toBeUndefined();
    const bad = await h.api("POST", "/automations", {
      projectId: h.projectId,
      name: "Bad",
      trigger: { type: "cron", expression: "61 * * * *" },
      action: { type: "start_session", prompt: "x" },
    });
    expect(bad.status).toBe(400);
    const patched = await h.api("PATCH", `/automations/${item.automation.id}`, {
      target: { type: "all_projects" },
      action: { type: "start_session", prompt: "New", autonomy: "full", effort: "high" },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as AutomationListItem).automation).toMatchObject({
      target: { type: "all_projects" },
      action: { autonomy: "full", effort: "high" },
    });
  });

  it("duplicates a file automation into an editable copy, off", async () => {
    const file = await waitUntil(async () =>
      (await list()).automations.find((i) => i.automation.source === "project_file"),
    );
    expect(file.readOnly).toBe(true);
    const res = await h.api("POST", `/automations/${file.automation.id}/duplicate`, {});
    expect(res.status).toBe(201);
    const copy = res.body as AutomationListItem;
    expect(copy.readOnly).toBe(false);
    expect(copy.automation).toMatchObject({
      name: "Release notes draft (copy)",
      source: "database",
      enabled: false,
      target: { type: "project", projectId: h.projectId },
      workKey: "automation:release-notes",
    });
  });

  it("exports one automation and all of a project's as a zip", async () => {
    const file = (await list()).automations.find((i) => i.automation.source === "project_file");
    const one = AutomationExport.parse(
      (await h.api("GET", `/automations/${file?.automation.id}/export`)).body,
    );
    expect(one.fileName).toBe("release-notes-draft.md");
    expect(previewFile({ name: one.fileName, content: one.markdown }).automation).toMatchObject({
      name: "Release notes draft",
      workKey: "automation:release-notes",
    });
    const all = ExportAutomationsResponse.parse(
      (await h.api("GET", `/automations/export?projectId=${h.projectId}`)).body,
    );
    const entries = unzipSync(new Uint8Array(Buffer.from(all.zipBase64, "base64")));
    expect(Object.keys(entries)).toHaveLength(all.count);
    expect(all.count).toBe((await list()).automations.length);
    expect(Object.values(entries).every((b) => strFromU8(b).startsWith("---\n"))).toBe(true);
  });

  it("previews and imports files, always off, and never runs anything", async () => {
    const source = {
      files: [
        { name: "release.md", content: RELEASE_NOTES.replace("read_only", "full") },
        { name: "broken.md", content: "---\nname: x\n---\n" },
      ],
    };
    const preview = AutomationImportPreviewResponse.parse(
      (await h.api("POST", "/automations/import/preview", source)).body,
    );
    expect(preview.items.map((i) => [i.fileName, i.error === null, i.fullPermissions])).toEqual([
      ["release.md", true, true],
      ["broken.md", false, false],
    ]);
    const before = (await list()).automations.length;
    const res = await h.api("POST", "/automations/import", { source, projectId: h.projectId });
    expect(res.status).toBe(201);
    const result = ImportAutomationsResponse.parse(res.body);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.automation).toMatchObject({
      enabled: false,
      createdBy: "import",
      target: { type: "project", projectId: h.projectId },
    });
    expect(result.failed.map((f) => f.fileName)).toEqual(["broken.md"]);
    expect((await list()).automations.length).toBe(before + 1);
    const runs = await h.api(
      "GET",
      `/automations/runs?automationId=${result.created[0]?.automation.id}`,
    );
    expect(runs.body).toEqual([]);

    const selected = ImportAutomationsResponse.parse(
      (await h.api("POST", "/automations/import", { source, select: ["broken.md"] })).body,
    );
    expect(selected.created).toEqual([]);
  });

  it("refuses oversized and malformed imports", async () => {
    const huge = { text: "x".repeat(AUTOMATION_IMPORT_LIMITS.maxFileChars + 1) };
    expect((await h.api("POST", "/automations/import/preview", huge)).status).toBe(400);
    // Past the body limit the route answers 413 before parsing (in process: over a socket the
    // client would see the connection close mid-upload).
    const body = JSON.stringify({ text: "y".repeat(3 * 1024 * 1024) });
    const direct = await automationRoutes(h.server.services).request("/import/preview", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(direct.status).toBe(413);
    expect((await h.api("POST", "/automations/import/preview", {})).status).toBe(400);
    const zip = zipOf({ "big.md": "z".repeat(AUTOMATION_IMPORT_LIMITS.maxFileChars + 10) });
    const res = await h.api("POST", "/automations/import/preview", { zipBase64: zip });
    expect(res.status).toBe(413);
  });

  it("lets the PM create and update automations, created off and marked", async () => {
    const res = await pmTool("create_automation", {
      name: "Nightly lint report",
      trigger: { type: "cron", expression: "0 2 * * *" },
      action: { type: "start_session", prompt: "Run the linter and report", autonomy: "read_only" },
    });
    expect(res.isError).toBeFalsy();
    const { created } = JSON.parse(res.text) as { created: { id: string; enabled: boolean } };
    expect(created.enabled).toBe(false);
    const saved = h.server.services.automations.definitions.get(created.id);
    expect(saved).toMatchObject({
      createdBy: "pm",
      enabled: false,
      target: { type: "project", projectId: h.projectId },
    });
    const bad = await pmTool("create_automation", {
      name: "Bad",
      trigger: { type: "cron", expression: "not cron" },
      action: { type: "message_pm", message: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/cron/i);
    const updated = await pmTool("update_automation", {
      automationId: created.id,
      trigger: { type: "manual" },
    });
    expect(updated.isError).toBeFalsy();
    expect(h.server.services.automations.definitions.get(created.id).trigger).toEqual({
      type: "manual",
    });
    const file = (await list()).automations.find((i) => i.automation.source === "project_file");
    const readOnly = await pmTool("update_automation", {
      automationId: file?.automation.id,
      name: "Renamed",
    });
    expect(readOnly.isError).toBe(true);
  });

  // #132: a PM must not change what an automation a person switched on does and leave it running.
  // Run by hand only, so nothing these tests leave switched on ever fires in the harness.
  const userAutomation = {
    name: "Dependency updates",
    trigger: { type: "manual" as const },
    action: {
      type: "start_session" as const,
      prompt: "Update dependencies",
      autonomy: "auto" as const,
    },
    enabled: true,
  };
  const rewrite = {
    trigger: { type: "cron", expression: "*/5 * * * *" },
    action: { type: "start_session", prompt: "Something else entirely", autonomy: "full" },
  };
  const defs = () => h.server.services.automations.definitions;
  const notice = (id: string) => h.server.services.inbox.find(pmChangeInboxId(id));

  it("switches off an automation that was on when the PM changes what it does", async () => {
    const on = defs().create({ ...userAutomation, projectId: h.projectId });
    const res = await pmTool("update_automation", { automationId: on.id, ...rewrite });
    expect(res.isError).toBeFalsy();
    const result = JSON.parse(res.text) as { updated: { enabled: boolean }; note: string };
    expect(result.updated.enabled).toBe(false);
    expect(result.note).toMatch(/switches it on again/);
    expect(defs().get(on.id)).toMatchObject({ enabled: false, action: rewrite.action });
    const item = notice(on.id);
    expect(item).toMatchObject({
      kind: "message",
      status: "open",
      notify: "needs_you",
      projectId: h.projectId,
      sessionId: "pm-test",
    });
    expect(item?.body).toContain('action.autonomy: "auto" → "full"');
    expect(item?.body).toContain('trigger.expression: none → "*/5 * * * *"');

    const guarded = defs().create({ ...userAutomation, projectId: h.projectId });
    await pmTool("update_automation", { automationId: guarded.id, guards: { maxPerDay: 50 } });
    expect(defs().get(guarded.id).enabled).toBe(false);
  });

  it("keeps it on for a new name or description, and off when it was off", async () => {
    const on = defs().create({ ...userAutomation, projectId: h.projectId });
    const renamed = await pmTool("update_automation", {
      automationId: on.id,
      name: "Dependency bumps",
      description: "Weekly",
      action: userAutomation.action,
    });
    expect(renamed.isError).toBeFalsy();
    expect(defs().get(on.id)).toMatchObject({ enabled: true, name: "Dependency bumps" });
    expect(notice(on.id)).toBeUndefined();

    const off = defs().create({ ...userAutomation, projectId: h.projectId, enabled: false });
    const res = await pmTool("update_automation", { automationId: off.id, ...rewrite });
    expect(JSON.parse(res.text)).not.toHaveProperty("note");
    expect(defs().get(off.id)).toMatchObject({ enabled: false, action: rewrite.action });
    expect(notice(off.id)).toBeUndefined();
  });

  it("refuses the PM's changes to an automation for all projects", async () => {
    const global = defs().create(userAutomation);
    expect(global.target).toEqual({ type: "all_projects" });
    const res = await pmTool("update_automation", { automationId: global.id, name: "Renamed" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/only the user/);
    expect(defs().get(global.id)).toMatchObject({ enabled: true, name: userAutomation.name });
  });

  it("leaves the user's own changes in Automations on", async () => {
    const on = defs().create({ ...userAutomation, projectId: h.projectId });
    const patched = await h.api("PATCH", `/automations/${on.id}`, { action: rewrite.action });
    expect(patched.status).toBe(200);
    expect(defs().get(on.id)).toMatchObject({ enabled: true, action: rewrite.action });
  });
});
