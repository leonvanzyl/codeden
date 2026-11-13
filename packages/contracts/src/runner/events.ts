import { z } from "zod";
import { AgentEvent } from "../agent-events";
import { ErrorInfo, Id } from "../common";
import {
  BrowserDialog,
  BrowserDialogClosed,
  BrowserEngine,
  BrowserFrameMetadata,
  BrowserTab,
  BrowserTabId,
} from "./browser";
import { CheckpointIndex, PtyId } from "./commands";

/**
 * Durable runner -> server events. Journaled by the runner and delivered with a `seq`
 * until the server acknowledges them (§4.2), so nothing is lost while the server is away.
 */
export const RunnerEvent = z.discriminatedUnion("kind", [
  /** A normalized agent event for a session. */
  z.object({ kind: z.literal("agent"), sessionId: Id, event: AgentEvent }),
  /** Provider process lifecycle for a session. */
  z.object({
    kind: z.literal("session.process"),
    sessionId: Id,
    state: z.enum(["starting", "ready", "exited", "crashed"]),
    exitCode: z.int().nullable().optional(),
    error: ErrorInfo.optional(),
    /**
     * Why an exited session closed: `stopped` (asked to), `runner_exit` (the runner is
     * draining or shutting down; the session stays resumable), `ended` (provider ended it).
     */
    reason: z.enum(["stopped", "runner_exit", "ended"]).optional(),
    /** True when a running turn was cut off by the runner exiting (resume and continue). */
    interruptedTurn: z.boolean().optional(),
  }),
  /** Output of `workspace.prepare` setup commands. */
  z.object({
    kind: z.literal("workspace.setup"),
    sessionId: Id,
    status: z.enum(["running", "succeeded", "failed"]),
    command: z.string(),
    output: z.string().optional(),
  }),
  z.object({ kind: z.literal("pty.exited"), ptyId: PtyId, exitCode: z.int().nullable() }),
  /** A turn checkpoint was written to `refs/codeden/checkpoints/<session>/<index>` (§9). */
  z.object({
    kind: z.literal("checkpoint.created"),
    sessionId: Id,
    index: CheckpointIndex,
    ref: z.string(),
    commit: z.string(),
    /** The turn that ended (absent for the baseline checkpoint 0). */
    turnId: Id.optional(),
  }),
  /** The runner started draining (upgrade/shutdown). */
  z.object({ kind: z.literal("runner.draining"), reason: z.string() }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
export type RunnerEventKind = RunnerEvent["kind"];

/**
 * Ephemeral runner -> server stream data. Not journaled, no `seq`, no ack: dropping it while
 * the server is away is fine (terminals keep scrollback in the runner).
 */
export const RunnerStream = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pty.output"), ptyId: PtyId, data: z.string() }),
  z.object({
    kind: z.literal("browser.frame"),
    sessionId: Id,
    mediaType: z.enum(["image/jpeg", "image/png"]),
    /** Base64 frame data. */
    data: z.string(),
    width: z.int().positive(),
    height: z.int().positive(),
    /** Tab the frame belongs to. */
    tabId: BrowserTabId.optional(),
    /** Viewport geometry at capture time, for mapping panel input onto the page. */
    metadata: BrowserFrameMetadata.optional(),
  }),
  /**
   * The session's tabs changed (opened, closed, activated, navigated, retitled), or its engine
   * did (hand-off to the runner's Chromium). An empty list means the browser closed.
   */
  z.object({
    kind: z.literal("browser.tabs"),
    sessionId: Id,
    tabs: z.array(BrowserTab),
    engine: BrowserEngine.optional(),
  }),
  /**
   * The session's page dialogs changed: one opened, or `closed` just closed. `dialogs` is every
   * dialog still waiting for an answer (at most one per tab).
   */
  z.object({
    kind: z.literal("browser.dialogs"),
    sessionId: Id,
    dialogs: z.array(BrowserDialog),
    closed: BrowserDialogClosed.optional(),
  }),
]);
export type RunnerStream = z.infer<typeof RunnerStream>;
