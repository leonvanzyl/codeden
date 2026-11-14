import { z } from "zod";

/** Opaque identifier (UUIDs in practice, but never parsed). */
export const Id = z.string().min(1).max(200);
export type Id = z.infer<typeof Id>;

/** UTC ISO-8601 timestamp, e.g. `2026-11-07T10:24:00.000Z`. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** Arbitrary JSON value (tool inputs, structured results). */
export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

/** The three agent roles (§8.1). All are the same kind of session with different tools/prompts. */
export const Role = z.enum(["orchestrator", "pm", "agent"]);
export type Role = z.infer<typeof Role>;

/**
 * Permission levels of an agent session (§11.2), mapped onto each provider's native enforcement.
 * Shown in the UI as "Permissions"; stored as `autonomy`.
 * - `read_only`: reads and runs checks, but never edits files, commits or pushes. Needs a
 *   provider with `ProviderCapabilities.readOnly`.
 * - `supervised`: every edit and command asks.
 * - `auto`: edits and normal commands in the worktree run freely; risky actions ask (default).
 * - `full`: no approvals inside the worktree.
 */
export const AutonomyLevel = z.enum(["read_only", "supervised", "auto", "full"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/** Reasoning effort. Each model advertises the subset it supports (see `ModelInfo.efforts`). */
export const ReasoningEffort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/**
 * Provider identifier such as `claude`, `codex`, `opencode` or `fake`. Deliberately an open string:
 * UI and orchestration must read capability flags, never branch on the id (Principle 5).
 */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * What kind of failure an agent turn hit, as the provider adapter classified it, so CodeDen can
 * recover by itself where waiting helps:
 * - `transient`: overloaded or failing API, a dropped connection, the agent CLI exiting; trying
 *   again shortly may work.
 * - `usage_limit`: the account's usage limit is reached; it works again at `retryAt`.
 * - `context_full`: the conversation no longer fits the model's context window.
 * - `auth`: the provider's login or credentials need the user.
 * - `setup`: the provider's CLI can't run sessions as installed: it is older than the oldest
 *   version CodeDen supports, so the user has to update it. Given when a session can't open.
 * - `fatal`: anything else; retrying the same turn won't help.
 */
export const ErrorKind = z.enum([
  "transient",
  "usage_limit",
  "context_full",
  "auth",
  "setup",
  "fatal",
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

/** Structured error carried by events, results and entities. */
export const ErrorInfo = z.object({
  /** Machine-readable code, e.g. `provider_crashed`, `not_found`. */
  code: z.string().optional(),
  /** Human-readable message, safe to show in the UI (never contains tokens). */
  message: z.string(),
  /** Whether retrying the same operation may succeed. */
  retryable: z.boolean().optional(),
  /** Optional extra detail (stack trace excerpt, stderr tail). */
  detail: z.string().optional(),
  /**
   * How a failed agent turn, or a session that couldn't open, can be recovered from; absent
   * where nobody classified it.
   */
  kind: ErrorKind.optional(),
  /** For `usage_limit`: when the limit resets, if the provider said. */
  retryAt: Timestamp.optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

/** Link to a GitHub issue. */
export const GitHubIssueRef = z.object({
  number: z.int().positive(),
  url: z.url(),
  title: z.string().optional(),
});
export type GitHubIssueRef = z.infer<typeof GitHubIssueRef>;

/** Link to a GitHub pull request. */
export const GitHubPrRef = z.object({
  number: z.int().positive(),
  url: z.url(),
  state: z.enum(["draft", "open", "closed", "merged"]),
  title: z.string().optional(),
});
export type GitHubPrRef = z.infer<typeof GitHubPrRef>;

/** Hours of the day during which something must not run or speak, e.g. `22:00`-`07:00`. */
export const QuietHours = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** IANA timezone; defaults to the machine's timezone when omitted. */
  timezone: z.string().optional(),
});
export type QuietHours = z.infer<typeof QuietHours>;
