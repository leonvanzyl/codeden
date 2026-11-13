import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StartSessionRequest,
  type StartSessionResponse,
  type UserInput,
  type WorkSummary,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { events } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ArtifactService } from "../src/services/artifacts";
import { InboxService } from "../src/services/inbox-service";
import { ConflictService } from "../src/services/orchestration/conflicts";
import type { SessionService } from "../src/services/sessions/session-service";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PROJECT = "p1";

const running: WorkSummary = {
  kind: "session",
  id: "s-old",
  sessionId: "s-old",
  projectId: PROJECT,
  startedBy: { kind: "user" },
  purpose: "Hold the work key",
  workKey: "issue:9",
  scope: { projectId: PROJECT },
  progress: null,
  status: "running",
  startedAt: "2026-11-12T10:00:00.000Z",
};

/** A New session draft's send: text, a pasted screenshot, the work key. */
const request = (text: string, projectId = PROJECT, over: Record<string, unknown> = {}) =>
  StartSessionRequest.parse({
    projectId,
    provider: "fake",
    workKey: "issue:9",
    ...over,
    input: {
      text,
      attachments: [
        {
          type: "image",
          mediaType: "image/png",
          name: "image.png",
          source: { type: "base64", data: PNG_B64 },
        },
      ],
    },
  });

let dir: string;
let database: Database;
let store: EventStore;
let artifacts: ArtifactService;
let inbox: InboxService;
let conflicts: ConflictService;
let start: ReturnType<typeof vi.fn<SessionService["start"]>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-conflict-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  artifacts = new ArtifactService(database.db, store, join(dir, "artifacts"));
  inbox = new InboxService(database.db, store, () => async () => undefined);
  start = vi.fn<SessionService["start"]>(
    async (): Promise<StartSessionResponse> => ({
      status: "queued",
      sessionId: "s-new",
      behind: ["s-old"],
    }),
  );
  conflicts = new ConflictService({
    db: database.db,
    store,
    inbox,
    artifacts,
    sessions: { start } as unknown as SessionService,
  });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every event's payload, as stored in the log. */
const log = () =>
  database.db
    .select()
    .from(events)
    .all()
    .map((e) => ({ type: e.type, json: JSON.stringify(e.payload) }));

/** The image the runner would get: the artifact's file, read back. */
function imageBytes(input: UserInput | undefined): string | undefined {
  const resolved = input && artifacts.resolveAttachments(input).attachments[0];
  if (resolved?.type !== "image" || resolved.source.type !== "path") return undefined;
  return readFileSync(resolved.source.path).toString("base64");
}

describe("recording a conflicting start with a pasted image (#169)", () => {
  it("keeps the image out of the event log and refers to it as an artifact", () => {
    const record = conflicts.record(request("Look at this screenshot"), [running]);
    const created = log().find((e) => e.type === "conflict.created");
    expect(created?.json).toBeDefined();
    expect(created?.json).not.toContain(PNG_B64);
    const saved = (record.start as { input: UserInput }).input;
    expect(saved.attachments[0]).toMatchObject({
      type: "image",
      name: "image.png",
      source: { type: "artifact" },
    });
    expect(imageBytes(saved)).toBe(PNG_B64);
  });

  it("starts with the image when the conflict is resolved", async () => {
    const record = conflicts.record(request("Look at this screenshot"), [running]);
    const out = await conflicts.resolve(record.id, { resolution: "wait", behindId: "s-old" });
    expect(out.result).toMatchObject({ status: "queued", sessionId: "s-new" });
    const req = start.mock.calls[0]?.[0];
    expect(req?.conflict).toEqual({ resolution: "wait", behindId: "s-old" });
    expect(req?.input?.text).toBe("Look at this screenshot");
    expect(imageBytes(req?.input)).toBe(PNG_B64);
    expect(log().filter((e) => e.json.includes(PNG_B64))).toEqual([]);
  });

  it("starts the request sent with the decision instead of the saved one", async () => {
    const record = conflicts.record(request("First wording"), [running]);
    const edited = request("Better wording, see the screenshot");
    const out = await conflicts.resolve(record.id, { resolution: "wait", start: edited });
    const req = start.mock.calls[0]?.[0];
    expect(req?.input?.text).toBe("Better wording, see the screenshot");
    expect(req?.input?.attachments).toHaveLength(1);
    expect(req?.conflict).toEqual({ resolution: "wait" });
    // Only the decision is kept on the conflict; the new request's image never reaches the log.
    expect(out.conflict).toMatchObject({ status: "resolved", resolution: { resolution: "wait" } });
    expect(out.conflict.resolution).toEqual({ resolution: "wait" });
    expect(log().filter((e) => e.json.includes(PNG_B64))).toEqual([]);
  });

  it("refuses a new request for another project", async () => {
    const record = conflicts.record(request("First wording"), [running]);
    await expect(
      conflicts.resolve(record.id, { resolution: "skip", start: request("x", "p2") }),
    ).rejects.toMatchObject({ code: "project_mismatch" });
    expect(start).not.toHaveBeenCalled();
    expect(conflicts.get(record.id).status).toBe("open");
  });
});

describe("a new version of a request replaces its open conflict (#169)", () => {
  const openConflictItems = () =>
    inbox.list({ projectId: PROJECT }).filter((i) => i.kind === "conflict");

  it("keeps one open conflict when the same request is recorded again", () => {
    const first = conflicts.record(request("First wording"), [running]);
    const second = conflicts.record(request("Second wording"), [running]);
    expect(conflicts.list({ projectId: PROJECT }).map((c) => c.id)).toEqual([second.id]);
    expect(openConflictItems().map((i) => i.id)).toEqual([second.id]);
    expect(conflicts.get(first.id).status).toBe("dismissed");
    expect(inbox.get(first.id).resolution).toMatchObject({ replacedBy: second.id });
    // Closed in the same append as the new record: nothing in between.
    const types = log().map((e) => e.type);
    expect(types.slice(-3)).toEqual(["conflict.created", "inbox.created", "inbox.updated"]);
  });

  it("closes the conflict a re-send names, even when its work key changed", () => {
    const first = conflicts.record(request("Fix login"), [running]);
    const second = conflicts.record(
      request("Fix signup", PROJECT, { workKey: "issue:10", replacesConflict: first.id }),
      [running],
    );
    expect(conflicts.list({ projectId: PROJECT }).map((c) => c.id)).toEqual([second.id]);
    // The id is not part of the saved request.
    expect(second.start).not.toHaveProperty("replacesConflict");
  });

  it("leaves other starters' and other projects' conflicts open", () => {
    const mine = conflicts.record(request("First wording"), [running]);
    conflicts.record(
      request("Nightly run", PROJECT, { startedBy: { kind: "automation", id: "a1" } }),
      [running],
    );
    conflicts.record(request("Elsewhere", "p2", { replacesConflict: mine.id }), [running]);
    expect(conflicts.get(mine.id).status).toBe("open");
    expect(openConflictItems()).toHaveLength(2);
  });

  it("closes the replaced conflict when the re-send goes ahead without one", () => {
    const first = conflicts.record(request("First wording"), [running]);
    const resent = request("Now it starts", PROJECT, { replacesConflict: first.id });
    conflicts.closeReplaced(resent, { status: "started", sessionId: "s-new" });
    expect(conflicts.get(first.id)).toMatchObject({
      status: "dismissed",
      outcome: { status: "started", sessionId: "s-new" },
    });
    expect(openConflictItems()).toEqual([]);
    // Closed already, unknown or absent: nothing to do.
    expect(() => conflicts.closeReplaced(resent, { status: "skipped" })).not.toThrow();
    const unknown = request("x", PROJECT, { replacesConflict: "conflict:none" });
    expect(() => conflicts.closeReplaced(unknown, { status: "skipped" })).not.toThrow();
    expect(() => conflicts.closeReplaced(request("x"), { status: "skipped" })).not.toThrow();
  });
});
