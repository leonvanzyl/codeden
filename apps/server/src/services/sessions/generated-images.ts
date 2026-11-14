import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  type AgentEventOf,
  agentEventToNewEvent,
  type GeneratedImage,
  type Item,
  type RawEventEnvelope,
} from "@codeden/contracts";
import { imageInfo, platformPath } from "@codeden/providers";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { type ArtifactService, MAX_ATTACHMENT_BYTES, sharedArtifactNotice } from "../artifacts";
import { errorMessage } from "../errors";
import { isRemoteRunner, type RunnerDeps, type RunnerPort, runnerForSession } from "../runner-port";
import { RunnerWorkspaceFs } from "../workspace-fs/runner";
import type { SessionRepo } from "./repo";

/** Captions are cut to the length `share_to_chat` accepts. */
const MAX_CAPTION = 1_000;

type Completed = AgentEventOf<"item.completed">;

export interface GeneratedImagesDeps extends Partial<RunnerDeps> {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  artifacts: ArtifactService;
  log?: (message: string) => void;
}

/**
 * Images agents create with their provider's own tools (e.g. Codex's built-in image generation)
 * arrive as finished tool calls that point at the image file (`generatedImages`), never with the
 * bytes. Each image is copied into the session's artifacts once and shown inline in its turn,
 * the way `share_to_chat` images are. An image that can't be stored gets a warning notice
 * instead. Either notice marks the image as handled: on start, finished calls whose images have
 * no notice yet (the server stopped while copying them) are handled then.
 */
export class GeneratedImages {
  private unsubscribe: (() => void) | undefined;
  /** Notices being posted, so a repeated `item.completed` never stores an image twice. */
  private readonly posting = new Set<string>();
  /** Posts still running, for `idle`. */
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: GeneratedImagesDeps) {}

  /** Watch new tool calls, and handle the stored ones whose images were never shown. */
  start(): Promise<void> {
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
    return this.track(this.recover());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Resolves once every post started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "agent.item.completed" || !e.sessionId) continue;
      const event = e.payload as Completed;
      if (!hasImages(event.item)) continue;
      const sessionId = e.sessionId;
      // After the current append: posting appends events of its own.
      this.track(Promise.resolve().then(() => this.post(sessionId, event)));
    }
  }

  /** Finished tool calls with images that have no notice yet. */
  private async recover(): Promise<void> {
    const rows = this.deps.db
      .select({
        sessionId: items.sessionId,
        threadId: items.threadId,
        turnId: items.turnId,
        item: items.data,
      })
      .from(items)
      .where(
        and(
          eq(items.kind, "tool_call"),
          eq(items.status, "completed"),
          sql`json_extract(${items.data}, '$.generatedImages') is not null`,
        ),
      )
      .all();
    for (const row of rows) {
      const { sessionId, ...event } = row;
      await this.post(sessionId, { type: "item.completed", ...event });
    }
  }

  /**
   * Store the images of a finished tool call and show each in its turn, once per image (a
   * repeated call is a no-op). Never throws.
   */
  async post(sessionId: string, event: Completed): Promise<void> {
    if (!hasImages(event.item)) return;
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session) return;
    for (const [index, image] of event.item.generatedImages.entries()) {
      const noticeId = `${event.item.id}-image-${index + 1}`;
      const key = `${sessionId}\n${noticeId}`;
      if (this.posting.has(key) || this.posted(sessionId, noticeId)) continue;
      this.posting.add(key);
      try {
        const file = await readImage(image.path, this.remoteRunner(sessionId));
        const artifact = this.deps.artifacts.save({
          bytes: file.bytes,
          name: basename(image.path),
          mediaType: file.mediaType,
          kind: "image",
          projectId: session.projectId,
          sessionId,
        });
        const caption = image.caption?.slice(0, MAX_CAPTION);
        this.append(sessionId, event, sharedArtifactNotice(artifact, caption, noticeId));
      } catch (error) {
        this.deps.log?.(`generated image ${image.path}: ${errorMessage(error)}`);
        this.append(sessionId, event, unavailableNotice(noticeId, image, error));
      } finally {
        this.posting.delete(key);
      }
    }
  }

  /**
   * The session's runner when it isn't the home runner: its images are on its own disk and are
   * read through it, never from this disk at a path it reported (§10).
   */
  private remoteRunner(sessionId: string): RunnerPort | undefined {
    const { runner, runners } = this.deps;
    if (!runner) return undefined;
    const port = runnerForSession({ runner, runners }, sessionId);
    return isRemoteRunner(port) ? port : undefined;
  }

  private append(sessionId: string, event: Completed, item: Item): void {
    try {
      this.deps.store.append([
        agentEventToNewEvent(sessionId, {
          type: "item.completed",
          threadId: event.threadId,
          turnId: event.turnId,
          item,
        }),
      ]);
    } catch (error) {
      this.deps.log?.(`generated image notice ${item.id}: ${errorMessage(error)}`);
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

  private track(work: Promise<void>): Promise<void> {
    const done = work.catch((error: unknown) => {
      this.deps.log?.(`generated images: ${errorMessage(error)}`);
    });
    this.running.add(done);
    void done.finally(() => this.running.delete(done));
    return done;
  }
}

/** A finished tool call that created images. */
function hasImages(
  item: Item,
): item is Extract<Item, { kind: "tool_call" }> & { generatedImages: GeneratedImage[] } {
  return item.kind === "tool_call" && item.status === "completed" && !!item.generatedImages?.length;
}

/** Shown in place of an image that could not be stored, so the user knows it is missing. */
function unavailableNotice(id: string, image: GeneratedImage, error: unknown): Item {
  return {
    id,
    kind: "notice",
    status: "completed",
    level: "warning",
    code: "generated_image_unavailable",
    message: `Couldn't show the generated image ${basename(image.path)}: ${errorMessage(error)}`,
  };
}

/**
 * Read a generated image: an absolute path to a file of at most 20 MB whose bytes are a PNG,
 * JPEG, GIF or WebP image. Anything else is refused, so no other file becomes an artifact. On a
 * runner that doesn't share this disk (`remote`), the path is the runner's and is read through
 * it, in its folder (its own guards apply).
 */
async function readImage(
  path: string,
  remote: RunnerPort | undefined,
): Promise<{ bytes: Buffer; mediaType: string }> {
  let bytes: Buffer;
  if (remote) {
    const platform = platformPath(remote.remote?.().platform);
    if (!platform.isAbsolute(path)) throw new Error("not an absolute path");
    const files = new RunnerWorkspaceFs(remote, platform.dirname(path));
    ({ bytes } = await files
      .readFile(platform.basename(path), MAX_ATTACHMENT_BYTES)
      .catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        if (code === "not_found" || code === "cwd_missing") {
          throw new Error("the file no longer exists");
        }
        throw code === "too_large" ? new Error("larger than 20 MB") : error;
      }));
  } else {
    if (!isAbsolute(path)) throw new Error("not an absolute path");
    const info = await stat(path).catch((error: unknown) => {
      const missing = (error as { code?: string }).code === "ENOENT";
      throw missing ? new Error("the file no longer exists") : error;
    });
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("larger than 20 MB");
    bytes = await readFile(path);
  }
  const meta = imageInfo(bytes);
  if (!meta) throw new Error("not an image");
  return { bytes, mediaType: meta.mimeType };
}
