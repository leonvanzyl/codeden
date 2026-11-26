import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ToolError } from "../src/mcp/define";
import { listInboxItems, resolveInboxItem } from "../src/mcp/tools/pm/inbox";
import { InboxService } from "../src/services/inbox-service";
import { removeTree } from "./support/remove-tree";

const ts = "2026-11-07T10:00:00.000Z";

/**
 * The PM's inbox tools (#673): it lists its project's open items and resolves stale triage
 * decisions and informational messages, with a reason the user can undo. Everything that waits
 * for a person's answer, and every other project's item, is refused. A real SQLite event log
 * projects the inbox; no runner.
 */
describe("the PM's inbox tools", () => {
  let dir: string;
  let db: Database;
  let inbox: InboxService;

  const put = (id: string, patch: Partial<InboxItem> = {}): InboxItem =>
    inbox.put({
      id,
      kind: "triage",
      status: "open",
      priority: "normal",
      notify: "automation",
      title: `Item ${id}`,
      body: null,
      projectId: "p1",
      sessionId: null,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: null,
      createdAt: ts,
      updatedAt: ts,
      resolvedAt: null,
      resolution: null,
      ...patch,
    });

  const ctx = () =>
    ({
      services: { inbox },
      projectId: "p1",
      sessionId: "pm-1",
      role: "pm",
      caller: "mcp",
      signal: new AbortController().signal,
    }) as never;
  const resolve = (inboxItemId: string, reason = "Issue #12 was closed upstream") =>
    resolveInboxItem.handler({ inboxItemId, reason }, ctx());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-pm-inbox-"));
    db = openDatabase(join(dir, "codeden.db"));
    inbox = new InboxService(db.db, new EventStore(db.db), () => async () => {});
  });

  afterEach(async () => {
    db.close();
    await removeTree(dir);
  });

  it("resolves a stale triage decision as the PM's, and the user can restore it", async () => {
    put("triage:p1:12", { issue: { number: 12, url: "https://github.com/a/b/issues/12" } });
    expect(await resolve("triage:p1:12")).toMatch(/restore/);
    const item = inbox.get("triage:p1:12");
    expect(item).toMatchObject({
      status: "resolved",
      resolution: { by: "pm", note: "Issue #12 was closed upstream" },
    });
    expect(inbox.restoreMany([item.id])).toEqual({ restored: 1, ids: [item.id] });
    expect(inbox.get(item.id)).toMatchObject({ status: "open", resolution: null });
  });

  it("resolves an informational message", async () => {
    put("m-info", { kind: "message", notify: "factory", priority: "low" });
    await resolve("m-info", "No longer applies");
    expect(inbox.get("m-info").status).toBe("resolved");
  });

  it.each([
    ["an approval", { kind: "approval", notify: "needs_you", sessionId: "s1", requestId: "r1" }],
    ["a user session's question", { kind: "question", notify: "needs_you", sessionId: "s1" }],
    ["an MCP server's form", { kind: "question", notify: "needs_you", requestId: "mcp-1" }],
    ["a message for the user to act on", { kind: "message", notify: "needs_you" }],
    ["a failure notice", { kind: "message", notify: "failure", priority: "high" }],
    ["another kind", { kind: "pr_review", notify: "needs_you" }],
    ["another project's triage decision", { projectId: "p2" }],
    ["a global item", { kind: "message", notify: "factory", projectId: null }],
  ] as const)("refuses %s", async (_what, patch) => {
    put("x", patch as Partial<InboxItem>);
    await expect(resolve("x")).rejects.toBeInstanceOf(ToolError);
    expect(inbox.get("x").status).toBe("open");
  });

  it("refuses items already closed, and ones that don't exist", async () => {
    const declined = put("triage:p1:3");
    inbox.close(declined, "dismissed", { decision: "decline" });
    await expect(resolve("triage:p1:3")).rejects.toThrow(/already dismissed/);
    await expect(resolve("nope")).rejects.toThrow(/No inbox item nope/);
  });

  it("lists every open item of its project, saying which it may resolve", async () => {
    put("triage:p1:1", { issue: { number: 1, url: "https://github.com/a/b/issues/1" } });
    put("a1", { kind: "approval", notify: "needs_you", sessionId: "s1" });
    put("elsewhere", { projectId: "p2" });
    put("closed", { status: "resolved", resolvedAt: ts });
    const listed = (await listInboxItems.handler({}, ctx())) as {
      open: number;
      items: Array<{ id: string; issue: number | null; youMayResolve: boolean }>;
    };
    expect(listed.open).toBe(2);
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "triage:p1:1", issue: 1, youMayResolve: true }),
        expect.objectContaining({ id: "a1", youMayResolve: false }),
      ]),
    );
  });
});
