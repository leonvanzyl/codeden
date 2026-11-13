import { z } from "zod";
import { ErrorInfo, Id, JsonValue } from "./common";
import { UserInput } from "./input";

/**
 * Lifecycle status of an item. For `approval_request` and `user_question`,
 * `in_progress` means "waiting on a response".
 */
export const ItemStatus = z.enum(["in_progress", "completed", "failed", "declined", "cancelled"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

const itemBase = {
  /** Unique within the session. */
  id: Id,
  status: ItemStatus,
};

/** A message the user (or a PM/orchestrator acting as the user) sent. */
export const UserMessageItem = z.object({
  ...itemBase,
  kind: z.literal("user_message"),
  input: UserInput,
});

/** Assistant text (markdown). Streamed via `item.delta` `{ type: "text" }`. */
export const AssistantMessageItem = z.object({
  ...itemBase,
  kind: z.literal("assistant_message"),
  text: z.string(),
});

/** Model reasoning, when the provider exposes it. */
export const ReasoningItem = z.object({
  ...itemBase,
  kind: z.literal("reasoning"),
  text: z.string(),
  summary: z.string().optional(),
  /** True when the provider hides the content and only reports that reasoning happened. */
  redacted: z.boolean().optional(),
});

/** Preview of a tool's output. Large outputs are truncated and fetched on demand (§6). */
export const ToolOutput = z.object({
  text: z.string(),
  truncated: z.boolean().default(false),
  totalBytes: z.int().nonnegative().optional(),
  /** Artifact holding the full output when truncated. */
  artifactId: Id.optional(),
});
export type ToolOutput = z.infer<typeof ToolOutput>;

/** What kind of work a tool call performs; drives rendering, never provider-specific. */
export const ToolKind = z.enum([
  "command",
  "file_edit",
  "file_read",
  "search",
  "web",
  "mcp",
  "browser",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKind>;

/**
 * An image file a tool call created on this machine, e.g. with a provider's built-in image
 * generation. Items point at the file and never carry the image bytes: the server copies it
 * into the session's artifacts and shows it inline in the transcript, once per item.
 */
export const GeneratedImage = z.object({
  /** Absolute path of the image file. */
  path: z.string().min(1),
  /** Shown with the image, e.g. the prompt it was generated from. */
  caption: z.string().optional(),
});
export type GeneratedImage = z.infer<typeof GeneratedImage>;

const toolCallBase = {
  ...itemBase,
  kind: z.literal("tool_call"),
  /** Provider-native tool name, e.g. `Bash`, `apply_patch`, `mcp__codeden__finish`. */
  toolName: z.string(),
  /** Short human title, e.g. `Run pnpm test`. */
  title: z.string().optional(),
  /** Raw tool input as JSON. */
  input: JsonValue.optional(),
  output: ToolOutput.optional(),
  error: ErrorInfo.optional(),
  durationMs: z.int().nonnegative().optional(),
  /** Images the call created, by file path (see {@link GeneratedImage}). */
  generatedImages: z.array(GeneratedImage).optional(),
};

/** A single file change produced by a `file_edit` tool call. */
export const FileChange = z.object({
  path: z.string(),
  change: z.enum(["add", "modify", "delete", "rename"]),
  previousPath: z.string().optional(),
  /** Unified diff, when available. */
  diff: z.string().optional(),
  additions: z.int().nonnegative().optional(),
  deletions: z.int().nonnegative().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

/** Tool call item; a nested discriminated union on `toolKind`. */
export const ToolCallItem = z.discriminatedUnion("toolKind", [
  z.object({
    ...toolCallBase,
    toolKind: z.literal("command"),
    command: z.string(),
    cwd: z.string().optional(),
    exitCode: z.int().nullable().optional(),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("file_edit"),
    changes: z.array(FileChange),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("file_read"),
    path: z.string(),
    startLine: z.int().positive().optional(),
    endLine: z.int().positive().optional(),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("search"),
    query: z.string(),
    path: z.string().optional(),
    matchCount: z.int().nonnegative().optional(),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("web"),
    url: z.string().optional(),
    query: z.string().optional(),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("mcp"),
    server: z.string(),
    tool: z.string(),
  }),
  z.object({
    ...toolCallBase,
    toolKind: z.literal("browser"),
    action: z.string(),
    url: z.string().optional(),
  }),
  z.object({ ...toolCallBase, toolKind: z.literal("other") }),
]);
export type ToolCallItem = z.infer<typeof ToolCallItem>;

/** A proposed plan (markdown), e.g. from plan mode. */
export const PlanItem = z.object({
  ...itemBase,
  kind: z.literal("plan"),
  text: z.string(),
});

export const TodoStatus = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

/** The agent's working todo list. Updated in place via `item.updated`. */
export const TodoListItem = z.object({
  ...itemBase,
  kind: z.literal("todo_list"),
  todos: z.array(
    z.object({
      id: z.string().optional(),
      text: z.string(),
      status: TodoStatus,
    }),
  ),
});

/** Decisions a user (or policy) can make on an approval request. */
export const ApprovalDecision = z.enum(["allow_once", "allow_session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * Who decided an approval: the user, CodeDen's policy (an action the permission level allows,
 * or a denial in a session nobody is watching), or a PM.
 */
export const ApprovalDecider = z.enum(["user", "policy", "pm"]);
export type ApprovalDecider = z.infer<typeof ApprovalDecider>;

/**
 * What an approval request is about. `plan`: the agent finished planning (plan mode) and asks
 * to start implementing; approving continues at the session's permission level, denying keeps
 * it planning with the user's `message` as feedback.
 */
export const ApprovalAction = z.enum([
  "command",
  "file_change",
  "outside_worktree",
  "network",
  "git_destructive",
  "secrets",
  "tool",
  "plan",
  "other",
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/**
 * An approval the agent is waiting on (§11.2). Surfaces in the transcript, the parent thread
 * (for subagents) and the inbox. Answered with `RuntimeResponse { kind: "approval" }`.
 */
export const ApprovalRequestItem = z.object({
  ...itemBase,
  kind: z.literal("approval_request"),
  /** Id passed back to `ProviderSession.respond`. */
  requestId: Id,
  action: ApprovalAction,
  title: z.string(),
  /** Why this was flagged as risky. */
  reason: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  paths: z.array(z.string()).optional(),
  toolName: z.string().optional(),
  toolInput: JsonValue.optional(),
  /** The tool call item this approval gates, if any. */
  toolCallItemId: Id.optional(),
  /**
   * A link the request asks the user to open (an MCP server's URL elicitation, e.g. to sign
   * in). The card shows it; nothing opens it on the user's behalf. Web links only.
   */
  url: z.url({ protocol: /^https?$/ }).optional(),
  options: z.array(ApprovalDecision).default(["allow_once", "allow_session", "deny"]),
  decision: ApprovalDecision.optional(),
  decidedBy: ApprovalDecider.optional(),
});

/** One question in a `user_question` item. */
export const UserQuestion = z.object({
  id: Id,
  /** Short label (a few words) shown as a chip/header. */
  header: z.string().optional(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
  multiSelect: z.boolean().default(false),
  allowFreeText: z.boolean().default(true),
});
export type UserQuestion = z.infer<typeof UserQuestion>;

/** Questions the agent asks the user. Answered with `RuntimeResponse { kind: "answer" }`. */
export const UserQuestionItem = z.object({
  ...itemBase,
  kind: z.literal("user_question"),
  requestId: Id,
  questions: z.array(UserQuestion).min(1),
  /** Answers keyed by question id, once answered. */
  answers: z.record(z.string(), z.array(z.string())).optional(),
  /**
   * Who answered: the user, or the project manager of the session's project (its
   * `answer_question` tool, §8.2 step 5). Absent on questions answered before it was recorded.
   */
  decidedBy: z.enum(["user", "pm"]).optional(),
  /**
   * Asked through CodeDen's `ask_user` tool rather than the provider: stays open after its
   * turn ends, and an answer that arrives after the tool returned is sent as a new message.
   */
  deferred: z.boolean().optional(),
  /**
   * The MCP server asking, when the questions are its form (an MCP elicitation) rather than the
   * agent's own: the answers go to that server as data. Unattended sessions withdraw such a form
   * instead of answering it (§10.1).
   */
  mcpServer: z.string().min(1).optional(),
});

/**
 * Tokens one model used in a subagent run, in the four billed categories (§7.3, §12.6). The
 * server prices them when it reports the run's cost, like a turn's: the provider's USD figure
 * when it gave one, else the price table.
 */
export const SubagentModelUsage = z.object({
  /** Model id as the provider reports it; absent when it doesn't say (the session's model). */
  model: z.string().min(1).optional(),
  /** Uncached input tokens (excludes cache reads and writes). */
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  /** Reasoning/thinking tokens where reported; already counted in `outputTokens`. */
  reasoningTokens: z.int().nonnegative().optional(),
  /** USD the provider reported for these calls, when it reports one. */
  costUsd: z.number().nonnegative().optional(),
});
export type SubagentModelUsage = z.infer<typeof SubagentModelUsage>;

/**
 * What a finished subagent used, as its provider reports it (§7.3). Each figure is optional:
 * a provider that reports none leaves `SubagentItem.stats` out. Display only: never added to
 * usage totals (`usage.updated`), which come from the provider's own turn figures.
 */
export const SubagentStats = z.object({
  /** Tokens the subagent used in total (input, output and cache). */
  totalTokens: z.int().nonnegative().optional(),
  /** Tool calls the subagent made. */
  toolUses: z.int().nonnegative().optional(),
  /** How long the subagent ran, in milliseconds. */
  durationMs: z.int().nonnegative().optional(),
  /**
   * Tokens per model across the run's own model calls (a nested subagent's are on its own
   * card), for the card's cost (`SessionUsage.subagents`). Display only, like the rest.
   */
  usage: z.array(SubagentModelUsage).optional(),
});
export type SubagentStats = z.infer<typeof SubagentStats>;

/** A subagent run; its transcript lives in the child thread `childThreadId` (§7.3). */
export const SubagentItem = z.object({
  ...itemBase,
  kind: z.literal("subagent"),
  childThreadId: Id,
  /** Subagent type/name, e.g. `code-reviewer`. */
  agentType: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  /** Final result summary when completed. */
  summary: z.string().optional(),
  /** Tokens, tool calls and duration of the finished run, when the provider reports them. */
  stats: SubagentStats.optional(),
});

/** One suggested next prompt (§7.5). */
export const FollowupSuggestion = z.object({
  prompt: z.string().min(1),
  /** Short chip label; the UI falls back to a truncated prompt. */
  label: z.string().optional(),
});
export type FollowupSuggestion = z.infer<typeof FollowupSuggestion>;

/** Suggested follow-up prompts, stored on the turn and shown as chips (§7.5). */
export const FollowupsItem = z.object({
  ...itemBase,
  kind: z.literal("followups"),
  /** `agent`: via the `suggest_followups` tool; `utility`: fallback from the utility model. */
  source: z.enum(["agent", "utility"]),
  suggestions: z.array(FollowupSuggestion).min(1).max(4),
});

/** Informational notice inside a transcript (e.g. "context compacted"). */
export const NoticeItem = z.object({
  ...itemBase,
  kind: z.literal("notice"),
  level: z.enum(["info", "warning"]),
  code: z.string().optional(),
  message: z.string(),
  data: JsonValue.optional(),
});

/** An error shown inline in the transcript (the turn may still continue). */
export const ErrorItem = z.object({
  ...itemBase,
  kind: z.literal("error"),
  error: ErrorInfo,
});

/** Every item kind in a turn (§7.3). Discriminated on `kind` (tool calls also on `toolKind`). */
export const Item = z.discriminatedUnion("kind", [
  UserMessageItem,
  AssistantMessageItem,
  ReasoningItem,
  ToolCallItem,
  PlanItem,
  TodoListItem,
  ApprovalRequestItem,
  UserQuestionItem,
  SubagentItem,
  FollowupsItem,
  NoticeItem,
  ErrorItem,
]);
export type Item = z.infer<typeof Item>;
export type ItemKind = Item["kind"];
/** Narrow `Item` to one kind: `ItemOf<"subagent">`. */
export type ItemOf<K extends ItemKind> = Extract<Item, { kind: K }>;

/** Incremental update to an in-progress item, carried by `item.delta`. */
export const ItemDelta = z.discriminatedUnion("type", [
  /** Append to `text` of assistant_message / reasoning / plan. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** Append to a reasoning item's `summary`. */
  z.object({ type: z.literal("reasoning_summary"), text: z.string() }),
  /** Append to a tool call's `output.text` (live command output). */
  z.object({
    type: z.literal("tool_output"),
    text: z.string(),
    stream: z.enum(["stdout", "stderr"]).optional(),
  }),
  /** Streaming tool input JSON fragment (display only). */
  z.object({ type: z.literal("tool_input"), partialJson: z.string() }),
]);
export type ItemDelta = z.infer<typeof ItemDelta>;

/** The text a delta appends (`partialJson` for tool input). */
export function itemDeltaText(delta: ItemDelta): string {
  return delta.type === "tool_input" ? delta.partialJson : delta.text;
}
