import { z } from "zod";
import { ErrorInfo, Id } from "./common";
import { Item, ItemDelta } from "./items";

/**
 * Token/cost/rate-limit usage. Providers fill in what they report; everything is optional.
 * With a `turnId`, token counts and cost are that turn's own usage so far (never a running
 * session total). `inputTokens` excludes cache reads and writes; `reasoningTokens` is
 * already included in `outputTokens`.
 */
export const Usage = z.object({
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  cacheWriteTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
  /** Tokens currently occupying the context window. */
  contextTokens: z.int().nonnegative().optional(),
  contextWindow: z.int().positive().optional(),
  /** Cost in USD where the provider reports it. */
  costUsd: z.number().nonnegative().optional(),
  rateLimits: z
    .array(
      z.object({
        /** Window name, e.g. `5h`, `weekly`. */
        id: z.string(),
        status: z.enum(["ok", "warning", "limited"]),
        usedPercent: z.number().min(0).max(100).optional(),
        resetsAt: z.iso.datetime().optional(),
      }),
    )
    .optional(),
});
export type Usage = z.infer<typeof Usage>;

/** A conversation thread. Root threads have no parent; subagent threads link to their spawner. */
export const ThreadInfo = z.object({
  id: Id,
  parentThreadId: Id.optional(),
  /** The `subagent` item in the parent thread that spawned this thread. */
  parentItemId: Id.optional(),
  title: z.string().optional(),
  agentType: z.string().optional(),
});
export type ThreadInfo = z.infer<typeof ThreadInfo>;

const threadScoped = { threadId: Id };
const turnScoped = { threadId: Id, turnId: Id };

/** Session-level metadata changed (resume token assigned, model switched, title generated). */
export const SessionUpdatedEvent = z.object({
  type: z.literal("session.updated"),
  resumeToken: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  /** The agent entered or left plan mode on its own, e.g. it left once its plan was approved. */
  planMode: z.boolean().optional(),
});

/** A thread came into existence. Emitted for the root thread and every subagent thread. */
export const ThreadStartedEvent = z.object({
  type: z.literal("thread.started"),
  thread: ThreadInfo,
});

export const TurnStartedEvent = z.object({ type: z.literal("turn.started"), ...turnScoped });

export const TurnCompletedEvent = z.object({
  type: z.literal("turn.completed"),
  ...turnScoped,
  /** Provider stop reason, e.g. `end_turn`, `max_tokens`. */
  stopReason: z.string().optional(),
});

export const TurnFailedEvent = z.object({
  type: z.literal("turn.failed"),
  ...turnScoped,
  error: ErrorInfo,
});

export const TurnInterruptedEvent = z.object({
  type: z.literal("turn.interrupted"),
  ...turnScoped,
  /** `user`: interrupt button; `runner_restart`: cut off by a runner drain/crash; `provider`: provider-side. */
  reason: z.enum(["user", "runner_restart", "provider"]),
});

/** A new item appeared in a turn (possibly still in progress). */
export const ItemStartedEvent = z.object({
  type: z.literal("item.started"),
  ...turnScoped,
  item: Item,
});

/** Incremental content for an in-progress item. */
export const ItemDeltaEvent = z.object({
  type: z.literal("item.delta"),
  ...turnScoped,
  itemId: Id,
  delta: ItemDelta,
});

/** Full replacement of an item's state while it is still in progress (todo list edits, etc.). */
export const ItemUpdatedEvent = z.object({
  type: z.literal("item.updated"),
  ...turnScoped,
  item: Item,
});

/** Final state of an item. Authoritative: replaces anything accumulated from deltas. */
export const ItemCompletedEvent = z.object({
  type: z.literal("item.completed"),
  ...turnScoped,
  item: Item,
});

export const UsageUpdatedEvent = z.object({
  type: z.literal("usage.updated"),
  ...threadScoped,
  turnId: Id.optional(),
  usage: Usage,
});

/**
 * Normalized agent event (§7.3). Every provider adapter emits exactly this stream;
 * the UI and orchestration never see provider-native shapes.
 */
export const AgentEvent = z.discriminatedUnion("type", [
  SessionUpdatedEvent,
  ThreadStartedEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnInterruptedEvent,
  ItemStartedEvent,
  ItemDeltaEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  UsageUpdatedEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];
/** Narrow `AgentEvent` by type: `AgentEventOf<"item.delta">`. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

/** All agent event type names, useful for filters. */
export const AGENT_EVENT_TYPES = AgentEvent.options.map(
  (o) => o.shape.type.value,
) as readonly AgentEventType[];
