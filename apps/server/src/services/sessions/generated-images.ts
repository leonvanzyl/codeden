import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { type AgentEventOf, agentEventToNewEvent, type RawEventEnvelope } from "@codeden/contracts";
import { imageInfo } from "@codeden/providers";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { type ArtifactService, MAX_ATTACHMENT_BYTES, sharedArtifactNotice } from "../artifacts";
import { errorMessage } from "../errors";
import type { SessionRepo } from "./repo";

/** Captions are cut to the length `share_to_chat` accepts. */
const MAX_CAPTION = 1_000;

export interface GeneratedImagesDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  artifacts: ArtifactService;
  log?: (message: string) => void;
}

/**
 * Images agents create with their provider's own tools (e.g. Codex's built-in image generation)
 * arrive as finished tool calls that point at the image file (`generatedImages`), never with the
 * bytes. Each image is copied into the session's artifacts once and shown inline right after
 * its tool call, the way `share_to_chat` images are.
 */
export class GeneratedImages {
  private unsubscribe: (() => void) | undefined;
  /** Notices being posted, so a repeated `item.completed` never stores an image twice. */
  private readonly posting = new Set<string>();

  constructor(private readonly deps: GeneratedImagesDeps) {}

  start(): void {
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "agent.item.completed" || !e.sessionId) continue;
      const event = e.payload as AgentEventOf<"item.completed">;
      const { item } = event;
      if (item.kind !== "tool_call" || item.status !== "completed") continue;
      if (!item.generatedImages?.length) continue;
      const sessionId = e.sessionId;
      // After the current append: posting appends events of its own.
      setImmediate(() => void this.post(sessionId, event));
    }
  }

  /**
   * Store the images of a finished tool call and show each in its turn, once per image (a
   * repeated call is a no-op). Never throws: an image that can't be read is logged and skipped.
   */
  async post(sessionId: string, event: AgentEventOf<"item.completed">): Promise<void> {
    const { item } = event;
    if (item.kind !== "tool_call") return;
    for (const [index, image] of (item.generatedImages ?? []).entries()) {
      const noticeId = `${item.id}-image-${index + 1}`;
      const key = `${sessionId}\n${noticeId}`;
      if (this.posting.has(key) || this.posted(sessionId, noticeId)) continue;
      this.posting.add(key);
      try {
        const file = await readImage(image.path);
        const session = this.deps.repo.find(sessionId)?.session;
        if (!session) return;
        const artifact = this.deps.artifacts.save({
          bytes: file.bytes,
          name: basename(image.path),
          mediaType: file.mediaType,
          kind: "image",
          projectId: session.projectId,
          sessionId,
        });
        const notice = sharedArtifactNotice(
          artifact,
          image.caption?.slice(0, MAX_CAPTION),
          noticeId,
        );
        this.deps.store.append([
          agentEventToNewEvent(sessionId, {
            type: "item.completed",
            threadId: event.threadId,
            turnId: event.turnId,
            item: notice,
          }),
        ]);
      } catch (error) {
        this.deps.log?.(`generated image ${image.path}: ${errorMessage(error)}`);
      } finally {
        this.posting.delete(key);
      }
    }
  }

  private posted(sessionId: string, itemId: string): boolean {
    const row = this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.id, itemId)))
      .get();
    return row !== undefined;
  }
}

/**
 * Read a generated image: an absolute path to a file of at most 20 MB whose bytes are a PNG,
 * JPEG, GIF or WebP image. Anything else is refused, so no other file becomes an artifact.
 */
async function readImage(path: string): Promise<{ bytes: Buffer; mediaType: string }> {
  if (!isAbsolute(path)) throw new Error("not an absolute path");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("larger than 20 MB");
  const bytes = await readFile(path);
  const meta = imageInfo(bytes);
  if (!meta) throw new Error("not an image");
  return { bytes, mediaType: meta.mimeType };
}
