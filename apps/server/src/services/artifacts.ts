import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Artifact, ArtifactKind, Attachment, UserInput } from "@codeden/contracts";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToArtifact } from "../db/rows";
import { artifacts } from "../db/schema";
import type { EventStore } from "../events/store";
import { badRequest, notFound } from "./errors";
import { resolveInside } from "./files/path-guard";

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

/** Max size of one pasted attachment. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface SaveArtifactInput {
  bytes: Buffer;
  name: string;
  mediaType: string;
  kind: ArtifactKind;
  projectId?: string | null;
  sessionId?: string | null;
}

/** Files under `<home>/artifacts` (§6): screenshots, pasted images, full tool outputs. */
export class ArtifactService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly dir: string,
  ) {}

  save(input: SaveArtifactInput): Artifact {
    const id = randomUUID();
    const folder = input.sessionId ?? "shared";
    const relative = `${folder}/${id}${EXTENSIONS[input.mediaType] ?? ""}`;
    const absolute = resolveInside(this.dir, relative);
    mkdirSync(join(this.dir, folder), { recursive: true });
    writeFileSync(absolute, input.bytes);
    const artifact: Artifact = {
      id,
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      path: relative,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      threadId: null,
      itemId: null,
      createdAt: new Date().toISOString(),
    };
    this.store.append([
      { type: "artifact.created", sessionId: artifact.sessionId, payload: { artifact } },
    ]);
    return artifact;
  }

  /** The artifacts folder (`<home>/artifacts`). */
  get rootDir(): string {
    return this.dir;
  }

  /**
   * A session's own artifacts folder (`<home>/artifacts/<session>`): its screenshots and pasted
   * images. Tools that read files a session points at accept paths in it.
   */
  sessionDir(sessionId: string): string {
    return resolveInside(this.dir, sessionId);
  }

  get(id: string): Artifact {
    const artifact = this.find(id);
    if (!artifact) throw notFound(`No artifact ${id}`, "artifact_not_found");
    return artifact;
  }

  list(filter: { sessionId?: string; projectId?: string } = {}): Artifact[] {
    const conditions: SQL[] = [];
    if (filter.sessionId) conditions.push(eq(artifacts.sessionId, filter.sessionId));
    if (filter.projectId) conditions.push(eq(artifacts.projectId, filter.projectId));
    return this.db
      .select()
      .from(artifacts)
      .where(and(...conditions))
      .orderBy(desc(artifacts.createdAt))
      .limit(500)
      .all()
      .map(rowToArtifact);
  }

  /** Absolute path of an artifact's file, guaranteed to be inside the artifacts folder. */
  filePath(artifact: Artifact): string {
    return resolveInside(this.dir, artifact.path);
  }

  /**
   * Store pasted (base64) images as artifacts and point the attachment at the artifact, so
   * large payloads never land in the event log and stored input (queued messages, pending
   * starts) never carries a filesystem path. `resolveAttachments` turns the reference into a
   * file path when the input is handed to the runner.
   */
  externalizeAttachments(
    input: UserInput,
    owner: { sessionId: string; projectId: string | null },
  ): UserInput {
    if (!input.attachments.some((a) => a.type === "image" && a.source.type === "base64")) {
      return input;
    }
    const attachments = input.attachments.map((a): Attachment => {
      if (a.type !== "image" || a.source.type !== "base64") return a;
      const bytes = Buffer.from(a.source.data, "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw badRequest("Attachment is larger than 20 MB", "attachment_too_large");
      }
      const artifact = this.save({
        bytes,
        name: a.name ?? `pasted${EXTENSIONS[a.mediaType] ?? ""}`,
        mediaType: a.mediaType,
        kind: "image",
        ...owner,
      });
      return { ...a, source: { type: "artifact" as const, artifactId: artifact.id } };
    });
    return { ...input, attachments };
  }

  /**
   * Point artifact image attachments at their file, for the runner: providers read images by
   * path. Only call this on input that goes to the runner, never on what the browser sees.
   */
  resolveAttachments(input: UserInput): UserInput {
    if (!input.attachments.some((a) => a.type === "image" && a.source.type === "artifact")) {
      return input;
    }
    const attachments = input.attachments.map((a): Attachment => {
      if (a.type !== "image" || a.source.type !== "artifact") return a;
      const artifact = this.find(a.source.artifactId);
      if (!artifact) throw badRequest(`No artifact ${a.source.artifactId}`, "unknown_artifact");
      return { ...a, source: { type: "path" as const, path: this.filePath(artifact) } };
    });
    return { ...input, attachments };
  }

  /**
   * The artifact whose own file is `path`, or `undefined`. Providers echo the input they were
   * given, so a user message's image comes back as the resolved path (and older transcripts
   * stored it that way); this maps it back to the artifact the browser can load. Only an exact
   * match with an artifact's file inside the artifacts folder counts; nothing is read from disk.
   */
  artifactForPath(path: string): Artifact | undefined {
    const file = path.split(/[\\/]/).pop() ?? "";
    const id = file.replace(/\.[^.]*$/, "");
    if (!id) return undefined;
    const artifact = this.find(id);
    if (!artifact) return undefined;
    const expected = resolve(this.dir, artifact.path);
    return comparable(resolve(path)) === comparable(expected) ? artifact : undefined;
  }

  private find(id: string): Artifact | undefined {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? rowToArtifact(row) : undefined;
  }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const comparable = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
