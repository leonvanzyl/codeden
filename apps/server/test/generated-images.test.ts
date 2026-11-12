import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventOf } from "@codeden/contracts";
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
let images: GeneratedImages;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-genimg-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  artifacts = new ArtifactService(database.db, store, join(dir, "artifacts"));
  logged = [];
  images = new GeneratedImages({
    db: database.db,
    store,
    repo: new SessionRepo(database.db, store),
    artifacts,
    log: (m) => logged.push(m),
  });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const imageCall = (path: string): AgentEventOf<"item.completed"> => ({
  type: "item.completed",
  threadId: "t1",
  turnId: "u1",
  item: {
    id: "ig_1",
    kind: "tool_call",
    toolKind: "other",
    status: "completed",
    toolName: "image_generation",
    generatedImages: [{ path, caption: "A red fox in the snow" }],
  },
});

const notices = () =>
  database.db
    .select()
    .from(items)
    .where(and(eq(items.sessionId, "s1"), eq(items.kind, "notice")))
    .all()
    .map(rowToItemRecord);

describe("generated images", () => {
  it("stores the image as an artifact once and shows it in the tool call's turn", async () => {
    const file = join(dir, "ig_1.png");
    writeFileSync(file, PNG);
    await images.post("s1", imageCall(file));
    await images.post("s1", imageCall(file));

    const stored = artifacts.list({ sessionId: "s1" });
    expect(stored).toHaveLength(1);
    const artifact = stored[0];
    if (!artifact) throw new Error("no artifact");
    expect(artifact).toMatchObject({ kind: "image", mediaType: "image/png", name: "ig_1.png" });
    expect(readFileSync(artifacts.filePath(artifact)).equals(PNG)).toBe(true);

    const shown = notices();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      threadId: "t1",
      turnId: "u1",
      item: {
        id: "ig_1-image-1",
        code: "shared_artifact",
        message: "A red fox in the snow",
        data: { artifactId: artifact.id, mediaType: "image/png" },
      },
    });
  });

  it("never turns a file that is not an image into an artifact", async () => {
    const file = join(dir, "secret.png");
    writeFileSync(file, "not an image");
    await images.post("s1", imageCall(file));
    await images.post("s1", imageCall(join(dir, "missing.png")));
    expect(artifacts.list({ sessionId: "s1" })).toHaveLength(0);
    expect(notices()).toHaveLength(0);
    expect(logged).toHaveLength(2);
  });
});
