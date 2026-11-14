import { z } from "zod";
import { AutonomyLevel, Id, ProviderId, ReasoningEffort, Role, Timestamp } from "./common";
import { ApprovalDecider, ApprovalDecision } from "./items";

/**
 * What a provider can do (§7.1). The UI and orchestration read these flags and never branch
 * on the provider id (Principle 5).
 */
export const ProviderCapabilities = z.object({
  /** Sessions can be resumed from `resumeToken()`. */
  resume: z.boolean(),
  /** Input can be injected into a running turn. */
  steer: z.boolean(),
  interrupt: z.boolean(),
  /** Tool approvals can be routed to CodeDen. */
  approvals: z.boolean(),
  /** The agent can ask structured questions. */
  userQuestions: z.boolean(),
  /** Subagents surface as child threads. */
  subagents: z.boolean(),
  /** The conversation can be rolled back to an earlier turn. */
  rollback: z.boolean(),
  /**
   * A conversation can be forked, leaving the original untouched: the runner's `provider.fork`
   * copies it into a new one (a new resume token), and `SessionOptions.forkFrom` does the same
   * as a session opens.
   */
  fork: z.boolean(),
  /** Image attachments are accepted as input. */
  images: z.boolean(),
  planMode: z.boolean(),
  reasoningEffort: z.boolean(),
  /** MCP servers can be injected (required for CodeDen tools). */
  mcp: z.boolean(),
  skills: z.boolean(),
  /**
   * An autonomy change reaches a running turn from its next tool call. When false (or absent),
   * a running turn keeps its autonomy and the change applies from the next turn.
   */
  liveAutonomy: z.boolean().optional(),
  /**
   * The `read_only` permission level is enforced natively: no file edits, no writing shell
   * commands, no commits or pushes (§11.2). When false (or absent), sessions on this provider
   * cannot use `read_only`.
   */
  readOnly: z.boolean().optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

/** A model a provider offers. */
export const ModelInfo = z.object({
  id: z.string(),
  /**
   * The concrete model id this entry runs today, when the provider reports it and it differs
   * from `id` (an alias such as `opus` → `claude-opus-5-5`). Lets a stored full id match the
   * alias entry that covers it.
   */
  resolvedId: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  efforts: z.array(ReasoningEffort).default([]),
  defaultEffort: ReasoningEffort.optional(),
  isDefault: z.boolean().optional(),
  contextWindow: z.int().positive().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** Static description of a provider adapter as loaded by a runner. */
export const ProviderInfo = z.object({
  id: ProviderId,
  displayName: z.string(),
  capabilities: ProviderCapabilities,
  models: z.array(ModelInfo).default([]),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

/**
 * A copy of a tool that exists on disk but does not run, e.g. an npm shim whose package was
 * removed. Reported so the user can reinstall it or delete the leftover file (§14).
 */
export const BrokenExecutable = z.object({
  /** The file that was found, e.g. `C:\Users\x\AppData\Roaming\npm\claude.cmd`. */
  path: z.string(),
  /** What is wrong, as a phrase that follows the path: "points at a missing package". */
  reason: z.string(),
  /** The file a shim or link points at, when that is what is missing. */
  target: z.string().optional(),
});
export type BrokenExecutable = z.infer<typeof BrokenExecutable>;

/** A problem found while detecting a provider, with the one action that fixes it (§14). */
export const ProviderIssue = z.object({
  code: z.enum([
    "not_installed",
    /** Found on disk, but no copy runs (see `ProviderStatus.broken`). */
    "broken_install",
    "not_logged_in",
    "login_expiring",
    "version_unsupported",
    "detect_failed",
  ]),
  message: z.string(),
  fix: z
    .object({
      kind: z.enum(["install", "login", "upgrade"]),
      /** Command to run (in an embedded terminal), e.g. `claude auth login`. */
      command: z.string(),
    })
    .optional(),
  /**
   * For `version_unsupported`: the oldest version CodeDen runs at all. Set when sessions can't
   * open on the installed version, so the provider counts as unavailable; absent when the version
   * is only older than the one CodeDen was tested with and still runs.
   */
  minVersion: z.string().optional(),
});
export type ProviderIssue = z.infer<typeof ProviderIssue>;

/** Result of `ProviderAdapter.detect()`: installed? version? logged in? (§14). */
export const ProviderStatus = z.object({
  providerId: ProviderId,
  installed: z.boolean(),
  version: z.string().nullable(),
  executablePath: z.string().nullable(),
  /** `null` when login state could not be determined. */
  loggedIn: z.boolean().nullable(),
  authMethod: z.string().nullable(),
  account: z.string().nullable(),
  loginExpiresAt: Timestamp.nullable(),
  /** False when the installed version is outside the adapter's tested range. */
  supported: z.boolean(),
  issues: z.array(ProviderIssue).default([]),
  /** Copies that were found but do not run, skipped in favour of a working one (if any). */
  broken: z.array(BrokenExecutable).optional(),
  checkedAt: Timestamp,
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/** An MCP server handed to a provider session (CodeDen's local proxy, user servers). */
export const McpServerConfig = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("http"),
    name: z.string(),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Max seconds one tool call may take (long-running tools such as `ask_user`). */
    toolTimeoutSec: z.int().positive().max(86_400).optional(),
    /** Tools of this server run without approval prompts (CodeDen's own tools). */
    trusted: z.boolean().optional(),
  }),
  z.object({
    transport: z.literal("stdio"),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/**
 * CodeDen's own credential files, relative to its data directory (§15): the install token the
 * local API accepts, the runner lock holding the runner's bearer token, and the remote access
 * store (password hash and device sessions). An agent that read the tokens could drive CodeDen
 * itself, so agents never read or write these without the user, at any level (§11.2).
 */
export const CODEDEN_CREDENTIAL_FILES = [
  "install-token",
  "runner/runner.json",
  "remote-access.json",
] as const;

/**
 * Marks the copy CodeDen keeps of a data-folder file it could not read before resetting it to
 * defaults: `<file>.invalid-<timestamp>`, next to the file. A copy of a credential file holds the
 * same secrets, so `<credential file>.invalid-*` is guarded like the file itself (§11.2).
 */
export const INVALID_COPY_SUFFIX = ".invalid-";

/** Options for `ProviderAdapter.openSession`. */
export const SessionOptions = z.object({
  /** CodeDen session id. */
  sessionId: Id,
  role: Role,
  /** Working directory (worktree, repo root, or the orchestrator folder). */
  cwd: z.string().min(1),
  model: z.string().optional(),
  effort: ReasoningEffort.optional(),
  autonomy: AutonomyLevel,
  /** Extra system prompt appended to the provider's own. */
  systemPrompt: z.string().optional(),
  /** Provider session/thread id from a previous `resumeToken()`. */
  resumeToken: z.string().optional(),
  /**
   * Provider session/thread id of a conversation to fork as the session opens
   * (`capabilities.fork`): the provider copies it and the session resumes the copy, whose id
   * `resumeToken()` returns at once; the original is untouched. Ignored when `resumeToken` is
   * set, which wins. CodeDen's own forks copy the conversation earlier, in the fork request
   * (`provider.fork`), and so arrive with a `resumeToken`.
   */
  forkFrom: z.string().min(1).optional(),
  mcpServers: z.array(McpServerConfig).default([]),
  /** Extra env vars for the agent process (CodeDen secrets are never included). */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * False: the runner leaves `CI` out of the agent's environment instead of adding `CI=true`
   * (the session's project turned it off, `Project.agentCiEnv`, §4.2). Absent means true.
   */
  ciEnv: z.boolean().optional(),
  /** Extra directories the agent may read/write. */
  additionalDirectories: z.array(z.string()).default([]),
  /**
   * The branch this session owns: the branch of its own worktree, never the base branch. Under
   * Auto the agent may force-push it with a lease (`git push --force-with-lease`) without an
   * approval, for example after a rebase (§11.2).
   */
  ownBranch: z.string().min(1).optional(),
  /** Start in plan mode where supported. */
  planMode: z.boolean().default(false),
  /**
   * No writes to the workspace (orchestrator and PMs, §11.2): file edits and writing commands
   * are denied natively (Claude permission policy, Codex read-only sandbox).
   */
  readOnly: z.boolean().optional(),
  /**
   * CodeDen's data directory (§6). Touching its credential files (`CODEDEN_CREDENTIAL_FILES`)
   * asks at every level and is refused for read-only sessions (§11.2, §15); `$CODEDEN_HOME` in
   * the agent's commands resolves to it.
   */
  codedenHome: z.string().min(1).optional(),
});
export type SessionOptions = z.infer<typeof SessionOptions>;
export type SessionOptionsInit = z.input<typeof SessionOptions>;

/** Response to an `approval_request` or `user_question` item (`ProviderSession.respond`). */
export const RuntimeResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decision: ApprovalDecision,
    /** Optional note passed to the agent (e.g. why it was denied). */
    message: z.string().optional(),
    /** Who decided; default the user. CodeDen's own decisions are recorded as `policy`. */
    decidedBy: ApprovalDecider.optional(),
  }),
  z.object({
    kind: z.literal("answer"),
    /** Selected option labels and/or free text, keyed by question id. */
    answers: z.record(z.string(), z.array(z.string())),
  }),
  /** Withdraw the request (session stopping, request superseded). */
  z.object({ kind: z.literal("cancel") }),
]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;
