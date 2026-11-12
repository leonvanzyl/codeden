import { z } from "zod";
import { Id } from "./common";

/** Where the bytes of an attachment come from. */
export const AttachmentSource = z.discriminatedUnion("type", [
  /** Inline base64 data (pasted images). */
  z.object({ type: z.literal("base64"), data: z.base64() }),
  /** A file on the runner's filesystem. */
  z.object({ type: z.literal("path"), path: z.string().min(1) }),
  /** A stored CodeDen artifact (§6 `artifacts/`). */
  z.object({ type: z.literal("artifact"), artifactId: Id }),
]);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

/** Image MIME types accepted as agent input. */
export const ImageMediaType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = z.infer<typeof ImageMediaType>;

/** An attachment on a user message: an image, or a file reference. */
export const Attachment = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    mediaType: ImageMediaType,
    source: AttachmentSource,
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    /** Path on the runner, usually inside the session worktree. */
    path: z.string().min(1),
    name: z.string().optional(),
    mediaType: z.string().optional(),
  }),
]);
export type Attachment = z.infer<typeof Attachment>;

/**
 * Who sent a message to a session: the user, the orchestrator (to a PM), a PM (to its
 * sessions), the software factory's loop (its briefs, fix rounds and nudges), an automation,
 * or CodeDen itself (automatic wake-ups, retries, pull request feedback).
 */
export const MessageSender = z.enum([
  "user",
  "orchestrator",
  "pm",
  "factory",
  "automation",
  "codeden",
]);
export type MessageSender = z.infer<typeof MessageSender>;

/** Input that starts or steers a turn: text plus optional image/file attachments. */
export const UserInput = z.object({
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  /**
   * Who wrote the message, when it was not the user: recorded so the transcript can show the
   * sender without reading the text, a session's opening brief included. Absent on the user's
   * own messages and on every message stored before senders were recorded.
   */
  from: MessageSender.optional(),
  /**
   * Set by CodeDen on a message the orchestrator passes on to a PM from a turn the user's own
   * message started (§8.2): the PM's turn it starts carries the user's request, like a message
   * the user wrote to the PM. Only such turns may start work on issues by authors who aren't
   * trusted. Absent on every other message.
   */
  relayedForUser: z.boolean().optional(),
});
export type UserInput = z.infer<typeof UserInput>;
/** Input shape accepted before defaults are applied (`attachments` optional). */
export type UserInputInit = z.input<typeof UserInput>;

/** Senders whose messages are introduced to the agent with a line that names them. */
export type RoleSender = "pm" | "orchestrator";

/**
 * The first line of a message from a PM or the orchestrator, telling the agent who wrote it.
 * The only definition of these words: the server writes them, the UI recognises them.
 */
export const SENDER_LINES: Readonly<Record<RoleSender, string>> = {
  pm: "Message from your project manager:",
  orchestrator: "Message from the orchestrator:",
};

/**
 * Input for a message from a PM or the orchestrator: the sender is recorded in `from` and
 * named for the agent in the text's first line (`SENDER_LINES`).
 */
export function messageFrom(from: RoleSender, text: string): UserInput {
  return { text: `${SENDER_LINES[from]}\n${text}`, attachments: [], from };
}

/**
 * Who wrote a message, and its text without the sender line `messageFrom` added. A recorded
 * `from` wins. Without one (messages stored before senders were recorded, providers that echo
 * only the text back) a leading sender line identifies a PM or the orchestrator; anything else
 * is the user's.
 */
export function splitSender(
  text: string,
  from?: MessageSender,
): { from: MessageSender; text: string } {
  for (const sender of ["pm", "orchestrator"] as const) {
    if (from !== undefined && from !== sender) continue;
    const line = SENDER_LINES[sender];
    const rest = text.slice(line.length);
    if (text.startsWith(line) && (rest === "" || /^\r?\n/.test(rest))) {
      return { from: sender, text: rest.replace(/^\r?\n/, "") };
    }
  }
  return { from: from ?? "user", text };
}
