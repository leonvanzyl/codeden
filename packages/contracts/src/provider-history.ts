import { z } from "zod";
import { Id, ProviderId, Timestamp } from "./common";

/**
 * Keeping the conversations CodeDen starts out of a provider's own apps. Some vendors' apps list
 * every conversation in the user's home as the user's own history (Codex: the Recents of the
 * Codex apps), so CodeDen's factory, PM and orchestration sessions would crowd out the user's
 * chats. A provider with `capabilities.vendorHistory` hides its CodeDen conversations as it goes,
 * and can hide the ones already there on request: only conversations CodeDen recorded (its
 * sessions' resume tokens), never one CodeDen didn't start. Hidden is not deleted: CodeDen can
 * still resume and fork them.
 */

/** Most conversations one request looks at. */
export const PROVIDER_HISTORY_MAX = 5000;

/** Longest preview kept per conversation. */
export const PROVIDER_HISTORY_PREVIEW_MAX = 200;

/** A conversation CodeDen started that the provider's own apps still list. */
export const ProviderHistoryEntry = z.object({
  /** The conversation's resume token (Codex: the thread id). */
  resumeToken: z.string().min(1),
  /** What the vendor's app shows for it (usually its first message), shortened. */
  preview: z.string().max(PROVIDER_HISTORY_PREVIEW_MAX),
  /** Last activity, when the provider reports it. */
  updatedAt: Timestamp.nullable(),
});
export type ProviderHistoryEntry = z.infer<typeof ProviderHistoryEntry>;

/** Outcome of hiding conversations from the provider's own apps. */
export const ProviderHistoryHideResult = z.object({
  /** Hidden now (Codex: archived). CodeDen can still resume them. */
  hidden: z.array(z.string()),
  /** Not there to hide: already hidden, or deleted. */
  missing: z.array(z.string()),
  failed: z.array(z.object({ resumeToken: z.string(), message: z.string() })),
});
export type ProviderHistoryHideResult = z.infer<typeof ProviderHistoryHideResult>;

const ResumeTokens = z.array(z.string().min(1).max(200)).max(PROVIDER_HISTORY_MAX);

/** Runner commands for a provider's own history, spread into `RunnerCommand`. */
export const ProviderHistoryCommands = [
  /**
   * Which of `resumeTokens` the provider's own apps list as the user's history. Looks at no other
   * conversation. `unsupported` without `capabilities.vendorHistory`.
   */
  z.object({
    name: z.literal("provider.history.list"),
    providerId: ProviderId,
    resumeTokens: ResumeTokens,
  }),
  /**
   * Hide these conversations from the provider's own apps, keeping them resumable (Codex:
   * archive). Touches no other conversation. `unsupported` without `capabilities.vendorHistory`.
   */
  z.object({
    name: z.literal("provider.history.hide"),
    providerId: ProviderId,
    resumeTokens: ResumeTokens,
  }),
] as const;

/** Result schemas of `ProviderHistoryCommands`. */
export const ProviderHistoryCommandResults = {
  "provider.history.list": z.object({ entries: z.array(ProviderHistoryEntry) }),
  "provider.history.hide": ProviderHistoryHideResult,
};

/** A listed conversation with the CodeDen session it belongs to. */
export const ProviderHistorySessionEntry = ProviderHistoryEntry.extend({
  sessionId: Id,
  sessionTitle: z.string().nullable(),
});
export type ProviderHistorySessionEntry = z.infer<typeof ProviderHistorySessionEntry>;

/**
 * `GET /api/providers/:providerId/history`: the conversations CodeDen started that the provider's
 * own apps still list (a preview of what hiding them would do; nothing changes).
 */
export const ProviderHistoryResponse = z.object({
  providerId: ProviderId,
  /** Conversations CodeDen has recorded for this provider (its sessions' resume tokens). */
  recorded: z.int().nonnegative(),
  /** The recorded ones the vendor's apps list now, newest first. */
  entries: z.array(ProviderHistorySessionEntry),
});
export type ProviderHistoryResponse = z.infer<typeof ProviderHistoryResponse>;

/**
 * `POST /api/providers/:providerId/history/hide`: hide the conversations the preview listed.
 * `confirm` must be `true`: the user confirmed the preview. The server decides which
 * conversations to hide from its own record; the request names none.
 */
export const HideProviderHistoryRequest = z.object({ confirm: z.literal(true) });
export type HideProviderHistoryRequest = z.infer<typeof HideProviderHistoryRequest>;

export const HideProviderHistoryResponse = ProviderHistoryHideResult.extend({
  providerId: ProviderId,
});
export type HideProviderHistoryResponse = z.infer<typeof HideProviderHistoryResponse>;
