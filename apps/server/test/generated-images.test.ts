import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEventOf, agentEventToNewEvent } from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { rowToItemRecord } from "../src/db/rows";
import { items } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ArtifactService } from "../src/services/artifacts";
import { GeneratedImages } from "../src/services/sessions/generated-images";
import { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let database: Database;
let store: EventStore;
let artifacts: ArtifactService;
let started: GeneratedImages[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-genimg-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  artifacts = new ArtifactService(database.db, store, join(dir, "artifacts"));
  started = [];
});

afterEach(() => {
  for (const service of started) service.stop();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh service, as after a server start; resolves once its recovery pass is done. */
async function startService(): Promise<GeneratedImages> {
  const service = new GeneratedImages({
    db: database.db,
    store,
    repo: new SessionRepo(database.db, store),
    artifacts,
  });
  started.push(service);
  await service.start();
  return service;
}

/** Store a finished image tool call, the way runner ingestion does. */
function complete(id: string, path: string): void {
  const event: AgentEventOf<"item.completed"> = {
    type: "item.completed",
    threadId: "t1",
    turnId: "u1",
    item: {
      id,
      kind: "tool_call",
      toolKind: "other",
      status: "completed",
      toolName: "image_generation",
      generatedImages: [{ path, caption: `Caption of ${id}` }],
    },
  };
  store.append([agentEventToNewEvent("s1", event)]);
}

function image(name: string, bytes: Buffer | string = PNG): string {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

const notices = () =>
  database.db
    .select()
    .from(items)
    .where(and(eq(items.sessionId, "s1"), eq(items.kind, "notice")))
    .all()
    .map(rowToItemRecord)
    .flatMap((r) =>
      r.item.kind === "notice" ? [{ threadId: r.threadId, turnId: r.turnId, ...r.item }] : [],
    );

describe("generated images", () => {
  it("stores a finished call's image once and shows it in the call's turn", async () => {
    const service = await startService();
    const file = image("ig_1.png");
    complete("ig_1", file);
    complete("ig_1", file); // the same completion again
    await service.idle();

    const stored = artifacts.list({ sessionId: "s1" });
    expect(stored).toHaveLength(1);
    const artifact = stored[0];
    if (!artifact) throw new Error("no artifact");
    expect(artifact).toMatchObject({ kind: "image", mediaType: "image/png", name: "ig_1.png" });
    expect(readFileSync(artifacts.filePath(artifact)).equals(PNG)).toBe(true);
    expect(notices()).toEqual([
      expect.objectContaining({
        threadId: "t1",
        turnId: "u1",
        id: "ig_1-image-1",
        code: "shared_artifact",
        message: "Caption of ig_1",
        data: expect.objectContaining({ artifactId: artifact.id, mediaType: "image/png" }),
      }),
    ]);
  });

  it("shows on start the images of calls stored while it was not running, once", async () => {
    // Stored before any service runs, as when the server stopped mid-copy.
    complete("ig_missed", image("ig_missed.png"));
    const first = await startService();
    expect(notices().map((n) => n.id)).toEqual(["ig_missed-image-1"]);

    // Live completions still work next to the recovered one.
    complete("ig_live", image("ig_live.png"));
    await first.idle();
    first.stop();

    // Restarting again finds every image handled.
    const second = await startService();
    await second.idle();
    expect(
      notices()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["ig_live-image-1", "ig_missed-image-1"]);
    expect(artifacts.list({ sessionId: "s1" })).toHaveLength(2);
  });

  it("never turns another file into an artifact, and says the image is missing", async () => {
    const service = await startService();
    complete("ig_text", image("secret.png", "not an image"));
    complete("ig_gone", join(dir, "missing.png"));
    await service.idle();

    expect(artifacts.list({ sessionId: "s1" })).toHaveLength(0);
    // The two copies run side by side, so their notices may land in either order.
    const shown = notices().sort((a, b) => a.id.localeCompare(b.id));
    expect(shown.map((n) => [n.id, n.level, n.code])).toEqual([
      ["ig_gone-image-1", "warning", "generated_image_unavailable"],
      ["ig_text-image-1", "warning", "generated_image_unavailable"],
    ]);
    expect(shown[0]?.message).toBe(
      "Couldn't show the generated image missing.png: the file no longer exists",
    );

    // A restart does not retry them.
    await startService();
    expect(notices()).toHaveLength(2);
  });
});
