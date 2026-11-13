import { z } from "zod";
import { McpServerSpec } from "../agent-config";
import {
  MCP_TEST_MAX_TIMEOUT_MS,
  McpServerTestResult,
  McpStdioEnv,
} from "../agent-config-mcp-test";
import { AutonomyLevel, Id, ProviderId, ReasoningEffort } from "../common";
import { UserInput } from "../input";
import { ProjectConfigFile } from "../project-config";
import { ProviderInfo, ProviderStatus, RuntimeResponse, SessionOptions } from "../provider";
import { BrowserCommandResults, BrowserCommands } from "./browser";

/** Terminal (node-pty) id, unique per runner. */
export const PtyId = z.string().min(1).max(100);

/** Most characters of a failed setup command's output kept in `workspace.prepare` results. */
export const SETUP_TAIL_LIMIT = 2000;

/** Index of a turn checkpoint: 0 is the baseline at session start, n the end of turn n. */
export const CheckpointIndex = z.int().nonnegative();

/** Per-file change summary of a diff. */
export const DiffFileStat = z.object({
  path: z.string(),
  /** Previous path for renames and copies. */
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  binary: z.boolean(),
});
export type DiffFileStat = z.infer<typeof DiffFileStat>;

/**
 * Commands the server sends to a runner (§4.3), discriminated on `name`.
 * Each has a matching result schema in `RunnerCommandResults`.
 */
export const RunnerCommand = z.discriminatedUnion("name", [
  /** Report sessions, terminals and journal state. */
  z.object({ name: z.literal("runner.status") }),
  /** Finish or pause running turns, then stop accepting work (before an upgrade). */
  z.object({
    name: z.literal("runner.drain"),
    reason: z.string(),
    /** Max time to wait for running turns before interrupting them. Default 5 minutes. */
    timeoutMs: z.int().positive().optional(),
    /** Exit the process once drained, so the server starts a fresh runner (upgrades). */
    exitWhenDrained: z.boolean().optional(),
  }),
  /** Runtime configuration pushed by the server after each handshake. */
  z.object({
    name: z.literal("runner.configure"),
    /** Where the local MCP proxy forwards to (the server's `/mcp`); `null` disables it. */
    mcpUpstreamUrl: z.url().nullable(),
  }),
  /** Exit the runner process after closing sessions and terminals. */
  z.object({ name: z.literal("runner.shutdown") }),
  /**
   * Detect installed providers (all when `providerId` is omitted). Also refreshes their model
   * lists: in the background, or before answering when `waitForModels` is set.
   */
  z.object({
    name: z.literal("provider.detect"),
    providerId: ProviderId.optional(),
    /** Answer only once the model lists are refreshed, and include them as `providers`. */
    waitForModels: z.boolean().optional(),
    /**
     * `false`: only detect (installed, signed in), leaving the model lists alone; for periodic
     * availability checks, which must not start provider CLIs to list models. Default true.
     */
    refreshModels: z.boolean().optional(),
  }),
  /** One tool-less utility-model call (§7.4) through a provider's `utilityModel()`. */
  z.object({
    name: z.literal("provider.oneShot"),
    providerId: ProviderId,
    prompt: z.string().min(1),
    system: z.string().optional(),
    /** Provider model id; the provider's small default when omitted. */
    model: z.string().optional(),
    timeoutMs: z.int().positive().max(300_000).optional(),
  }),
  /**
   * Copy a conversation into a new one (`capabilities.fork`): the result is the copy's resume
   * token; the original is untouched. Fails with `unsupported` for a provider that can't fork.
   */
  z.object({
    name: z.literal("provider.fork"),
    providerId: ProviderId,
    /** The resume token of the conversation to copy. */
    resumeToken: z.string().min(1),
    /** An existing folder of the project, for providers that run a process to fork. */
    cwd: z.string().min(1),
    /**
     * Copy only through the turn that reported this fork point (`forkPoint` on a turn's end
     * event); later turns are left out. Omitted: the whole conversation.
     */
    upTo: z.string().min(1).optional(),
  }),
  /** Create or reuse the working directory for a session (worktree + setup commands). */
  z.object({
    name: z.literal("workspace.prepare"),
    sessionId: Id,
    repoPath: z.string().min(1),
    strategy: z.enum(["worktree", "repo_root", "existing"]),
    /** Target directory for `worktree` / `existing`. */
    path: z.string().optional(),
    branch: z.string().optional(),
    baseRef: z.string().optional(),
    setupCommands: z.array(z.string()).default([]),
    /** Used for the default worktree path `<home>/wt/<projectSlug>/<sessionShort>`. */
    projectSlug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional(),
    /** `git fetch origin` before branching (when an `origin` remote exists). */
    fetch: z.boolean().optional(),
    /** Run `.codeden/project.json` `setup` commands before `setupCommands`. Default true. */
    runProjectSetup: z.boolean().optional(),
    /**
     * A forked session's starting point: once a new worktree is created, its files are made to
     * match this checkpoint of another session (as uncommitted changes on top of the branch)
     * before setup commands run. Ignored when the worktree already existed.
     */
    restoreCheckpoint: z.object({ sessionId: Id, index: CheckpointIndex }).optional(),
  }),
  /**
   * Remove a session worktree (and optionally its branch). Idempotent: a missing path, or a
   * half-deleted folder under `<home>/wt/<project>/<session>` that is no longer a git worktree,
   * ends `removed`. A folder under `<home>/wt` is moved to `<home>/wt/.trash` (all or nothing)
   * and deleted in the background; nothing is ever deleted through a symlink or junction.
   * Fails with `worktree_dirty` (uncommitted changes, not forced), `worktree_locked`,
   * `worktree_in_use` (a file is held open; the worktree is untouched, retry later) or
   * `not_a_worktree` (left alone: not this repository's worktree, or outside `<home>/wt`).
   */
  z.object({
    name: z.literal("workspace.remove"),
    repoPath: z.string().min(1),
    path: z.string().min(1),
    deleteBranch: z.string().optional(),
    /** Remove even with uncommitted changes. */
    force: z.boolean().optional(),
  }),
  /** Open a provider session; optionally start the first turn. */
  z.object({
    name: z.literal("session.start"),
    sessionId: Id,
    providerId: ProviderId,
    options: SessionOptions,
    input: UserInput.optional(),
    /** Snapshot the cwd at session start and every turn end (§9). Default true in git repos. */
    checkpoints: z.boolean().optional(),
  }),
  /** Start a new turn. */
  z.object({ name: z.literal("session.send"), sessionId: Id, input: UserInput }),
  /** Inject input into the running turn (requires `capabilities.steer`). */
  z.object({ name: z.literal("session.steer"), sessionId: Id, input: UserInput }),
  z.object({ name: z.literal("session.interrupt"), sessionId: Id }),
  /** Answer an approval request or user question. */
  z.object({
    name: z.literal("session.respond"),
    sessionId: Id,
    requestId: Id,
    response: RuntimeResponse,
  }),
  /** Close the provider session (resumable later via its resume token). */
  z.object({ name: z.literal("session.stop"), sessionId: Id }),
  /**
   * Change model/effort for the next turn, and/or the autonomy level (§11.2): from the next
   * tool call when the provider reports `liveAutonomy`, otherwise from the next turn. `planMode`
   * turns plan mode on or off (`capabilities.planMode`). `unsupported` when the provider
   * cannot change a requested setting live.
   */
  z.object({
    name: z.literal("session.configure"),
    sessionId: Id,
    model: z.string().nullable().optional(),
    effort: ReasoningEffort.nullable().optional(),
    autonomy: AutonomyLevel.optional(),
    planMode: z.boolean().optional(),
  }),
  z.object({
    name: z.literal("pty.open"),
    ptyId: PtyId,
    cwd: z.string().min(1),
    shell: z.string().optional(),
    args: z.array(z.string()).optional(),
    cols: z.int().positive(),
    rows: z.int().positive(),
    env: z.record(z.string(), z.string()).optional(),
    sessionId: Id.optional(),
  }),
  z.object({ name: z.literal("pty.input"), ptyId: PtyId, data: z.string() }),
  z.object({
    name: z.literal("pty.resize"),
    ptyId: PtyId,
    cols: z.int().positive(),
    rows: z.int().positive(),
  }),
  z.object({ name: z.literal("pty.close"), ptyId: PtyId }),
  /** Scrollback and state of a terminal, for (re)attaching a view. */
  z.object({ name: z.literal("pty.attach"), ptyId: PtyId }),
  /** `browser.*` (§12.2), defined in `./browser`. */
  ...BrowserCommands,
  /** Snapshot the worktree into `refs/codeden/checkpoints/<session>/<n>` (§9). */
  z.object({
    name: z.literal("git.checkpoint"),
    sessionId: Id,
    cwd: z.string(),
    index: z.int().nonnegative(),
  }),
  z.object({ name: z.literal("git.status"), cwd: z.string() }),
  /** Unified diff `fromRef..toRef`; without `toRef`, against the working tree incl. untracked files. */
  z.object({
    name: z.literal("git.diff"),
    cwd: z.string(),
    fromRef: z.string(),
    toRef: z.string().optional(),
  }),
  z.object({
    name: z.literal("git.branches"),
    cwd: z.string(),
    includeRemote: z.boolean().optional(),
  }),
  /** Stage (all changes, or `paths`) and commit. */
  z.object({
    name: z.literal("git.commit"),
    cwd: z.string(),
    message: z.string().min(1),
    paths: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.literal("git.push"),
    cwd: z.string(),
    /** Default `origin`. */
    remote: z.string().optional(),
    /** Default: the current branch. */
    branch: z.string().optional(),
    /** Set the upstream (`-u`). Default true. */
    setUpstream: z.boolean().optional(),
    forceWithLease: z.boolean().optional(),
  }),
  z.object({
    name: z.literal("checkpoint.list"),
    cwd: z.string(),
    sessionId: Id,
    /**
     * First wait for checkpoints the runner is still writing for this session (the one for a
     * turn that just ended), so the list ends with the state the conversation has reached.
     */
    settled: z.boolean().optional(),
  }),
  /** Diff between two checkpoints; without `to`, against the current working tree. */
  z.object({
    name: z.literal("checkpoint.diff"),
    cwd: z.string(),
    sessionId: Id,
    from: CheckpointIndex,
    to: CheckpointIndex.optional(),
  }),
  /** Restore files (all, or `paths`) to their state at a checkpoint without touching the index. */
  z.object({
    name: z.literal("checkpoint.restoreFiles"),
    cwd: z.string(),
    sessionId: Id,
    index: CheckpointIndex,
    paths: z.array(z.string()).optional(),
  }),
  /** Listening localhost ports of processes started by this runner, plus `probe`d ports. */
  z.object({
    name: z.literal("ports.list"),
    probe: z.array(z.int().min(1).max(65535)).optional(),
  }),
  /**
   * Connection test of an MCP server (§12.4): start it (stdio) or reach its URL (http/sse),
   * run `initialize` and `tools/list`, then stop it. A failing server is an `ok: false` result.
   */
  z.object({
    name: z.literal("mcp.test"),
    spec: McpServerSpec,
    /** Working directory of a stdio server without its own `cwd`; the runner's home when omitted. */
    cwd: z.string().min(1).optional(),
    /** Expand `${VAR}` and `${VAR:-default}` from the runner's environment, as Claude Code does. */
    expandEnv: z.boolean(),
    /** How a stdio server's environment is built; `inherit` when omitted. */
    stdioEnv: McpStdioEnv.optional(),
    /** Default `MCP_TEST_DEFAULT_TIMEOUT_MS`. */
    timeoutMs: z.int().positive().max(MCP_TEST_MAX_TIMEOUT_MS).optional(),
  }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommand>;
export type RunnerCommandName = RunnerCommand["name"];
export type RunnerCommandOf<N extends RunnerCommandName> = Extract<RunnerCommand, { name: N }>;

/** A session currently hosted by the runner. */
export const RunnerSessionInfo = z.object({
  sessionId: Id,
  providerId: ProviderId,
  state: z.enum(["idle", "running", "closing"]),
  resumeToken: z.string().nullable(),
});
export type RunnerSessionInfo = z.infer<typeof RunnerSessionInfo>;

const Empty = z.object({});

/** Result schema for each command. */
export const RunnerCommandResults = {
  "runner.status": z.object({
    sessions: z.array(RunnerSessionInfo),
    ptys: z.array(PtyId),
    journal: z.object({ lastSeq: z.int().nonnegative(), unacked: z.int().nonnegative() }),
    draining: z.boolean(),
  }),
  "runner.drain": Empty,
  "runner.configure": z.object({ mcpProxyUrl: z.string().nullable() }),
  "runner.shutdown": Empty,
  "provider.detect": z.object({
    statuses: z.array(ProviderStatus),
    /** Every provider after the refresh; set when the command asked for `waitForModels`. */
    providers: z.array(ProviderInfo).optional(),
  }),
  "provider.oneShot": z.object({ text: z.string(), model: z.string() }),
  "provider.fork": z.object({ resumeToken: z.string().min(1) }),
  "workspace.prepare": z.object({
    cwd: z.string(),
    branch: z.string().nullable(),
    created: z.boolean(),
    /** Parsed `.codeden/project.json`, when present and valid. */
    config: ProjectConfigFile.nullable().optional(),
    /** Setup commands that ran, in order (stops at the first failure). */
    setup: z
      .array(
        z.object({
          command: z.string(),
          /** Null when the command was killed (timed out) before it exited. */
          exitCode: z.int().nullable(),
          ok: z.boolean(),
          /**
           * The end of a failed command's output (at most `SETUP_TAIL_LIMIT` characters), so
           * the server can tell the agent why setup failed. Absent for commands that succeeded
           * and from older runners.
           */
          outputTail: z.string().max(SETUP_TAIL_LIMIT).optional(),
        }),
      )
      .optional(),
  }),
  "workspace.remove": z.object({
    removed: z.boolean(),
    /** A forced removal deleted uncommitted changes (absent from older runners). */
    discardedChanges: z.boolean().optional(),
  }),
  "session.start": z.object({ resumeToken: z.string().nullable() }),
  "session.send": Empty,
  "session.steer": Empty,
  "session.interrupt": Empty,
  "session.respond": Empty,
  "session.stop": Empty,
  "session.configure": Empty,
  "pty.open": z.object({ pid: z.int() }),
  "pty.input": Empty,
  "pty.resize": Empty,
  "pty.close": Empty,
  "pty.attach": z.object({
    pid: z.int(),
    cols: z.int().positive(),
    rows: z.int().positive(),
    /** Bounded scrollback to replay into a fresh view. */
    scrollback: z.string(),
    exited: z.boolean(),
    exitCode: z.int().nullable(),
  }),
  ...BrowserCommandResults,
  "git.checkpoint": z.object({ ref: z.string(), commit: z.string() }),
  "git.status": z.object({
    branch: z.string().nullable(),
    ahead: z.int().nonnegative(),
    behind: z.int().nonnegative(),
    files: z.array(z.object({ path: z.string(), status: z.string() })),
  }),
  "git.diff": z.object({ diff: z.string(), files: z.array(DiffFileStat).optional() }),
  "git.branches": z.object({
    current: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    branches: z.array(
      z.object({
        name: z.string(),
        remote: z.boolean(),
        commit: z.string(),
        upstream: z.string().nullable(),
      }),
    ),
  }),
  /** `commit` is null when there was nothing to commit. */
  "git.commit": z.object({ commit: z.string().nullable() }),
  "git.push": z.object({ remote: z.string(), branch: z.string() }),
  "checkpoint.list": z.object({
    checkpoints: z.array(
      z.object({
        index: CheckpointIndex,
        ref: z.string(),
        commit: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  "checkpoint.diff": z.object({ diff: z.string(), files: z.array(DiffFileStat) }),
  "checkpoint.restoreFiles": z.object({
    restored: z.array(z.string()),
    deleted: z.array(z.string()),
  }),
  "ports.list": z.object({
    ports: z.array(
      z.object({
        port: z.int().min(1).max(65535),
        pid: z.int().nullable(),
        url: z.string(),
      }),
    ),
  }),
  "mcp.test": McpServerTestResult,
} satisfies Record<RunnerCommandName, z.ZodType>;

/** Result type of a command: `RunnerCommandResult<"session.start">`. */
export type RunnerCommandResult<N extends RunnerCommandName> = z.infer<
  (typeof RunnerCommandResults)[N]
>;
