import { randomUUID } from "node:crypto";
import type {
  HandoffSessionRequest,
  Project,
  ProviderInfo,
  Session,
  UserInput,
} from "@codeden/contracts";
import { badRequest, conflict, type ServiceError } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, toServiceError } from "../runner-port";
import type { UtilityService } from "../utility";
import type { ForkStart } from "./fork";
import { buildHandoffBrief, handoffTranscript } from "./handoff-brief";
import { planModeUnsupported, readOnlyUnsupported } from "./permissions";
import type { SessionRepo, StoredStartMeta } from "./repo";

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
const TITLE_MAX = 200;
/** Writing a checkpoint stages the whole worktree; a big one can take a while. */
const SETTLE_TIMEOUT_MS = 120_000;
/** Root-thread items the utility model's transcript is made from (the newest of them). */
const TRANSCRIPT_ITEMS = 600;

/**
 * A new session that continues another one from a brief, ready to be created and launched. Its
 * first message, the brief from CodeDen, is `meta.handoffBrief`: the launcher sends it.
 */
export interface HandoffPlan {
  session: Session;
  meta: StoredStartMeta;
  start: ForkStart;
}

export interface HandoffDeps {
  repo: SessionRepo;
  projects: ProjectService;
  /** The source's runner: it holds the source's checkpoints, and the new session runs there. */
  runner: RunnerPort;
  /** Writes the brief's summary (§7.4); without it the brief quotes the source's last reply. */
  utility?: Pick<UtilityService, "handoffSummary">;
}

/**
 * Why `source` can't be handed off right now, or null when it can (§9). A handoff needs an agent
 * session on a git branch that has had a turn, with no turn running or still to start. Unlike a
 * fork it needs neither `capabilities.fork` nor a resume token: the conversation isn't copied.
 */
export function handoffBlocker(source: Session, turns: number): ServiceError | null {
  if (source.role !== "agent") {
    return badRequest("Only agent sessions can be handed off", "fork_unsupported");
  }
  if (source.status === "waiting") {
    return conflict(
      "Answer what the session is waiting on (an approval, a question or its plan) before handing it off",
      "turn_running",
    );
  }
  if (BUSY.has(source.status)) {
    return conflict("Wait for the running turn to finish before handing off", "turn_running");
  }
  if (NOT_STARTED.has(source.status)) {
    return conflict("The session hasn't started yet", "not_started");
  }
  if (!source.branch) {
    return badRequest(
      "Only sessions that work on a git branch can be handed off",
      "fork_unsupported",
    );
  }
  if (turns === 0) {
    return conflict("The session has no work to hand off yet", "nothing_to_hand_off");
  }
  return null;
}

/** `<source title> (to <provider>)`, kept within the title limit. */
export function handoffTitle(source: Session, providerName: string): string {
  const suffix = ` (to ${providerName})`;
  const base = (source.title ?? source.purpose).trim();
  return base.length + suffix.length <= TITLE_MAX
    ? `${base}${suffix}`
    : `${base.slice(0, TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Hand `sourceId` off (§9): a new session on `req.provider` with the source's code, as a fork
 * has it, and a brief of its work as the first message instead of its conversation.
 * 1. The source's latest checkpoint, once the runner has written the one for a turn that has
 *    just ended (`checkpoint.list` `settled`).
 * 2. The brief, from the source's transcript and the utility model's summary of it.
 * A turn that started meanwhile, even one that has already finished, would make the two
 * disagree, so that fails the handoff (409 `source_changed`) and nothing is created. The source
 * is only read. Throws `ServiceError`s.
 */
export async function planHandoff(
  deps: HandoffDeps,
  sourceId: string,
  req: HandoffSessionRequest,
): Promise<HandoffPlan> {
  const { repo, runner } = deps;
  const source = repo.get(sourceId);
  const turns = repo.turnCount(source.id);
  const blocker = handoffBlocker(source, turns);
  if (blocker) throw blocker;
  const project = handoffProject(deps.projects, source);
  const target = targetProvider(runner, source, req.provider);
  const { checkpoints } = await runner
    .request(
      { name: "checkpoint.list", cwd: project.path, sessionId: source.id, settled: true },
      SETTLE_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      throw toServiceError(error);
    });
  const checkpoint = checkpoints.at(-1)?.index ?? null;
  const requests = repo
    .rootItems(source, ["user_message"])
    .flatMap((i) => (i.kind === "user_message" ? [i] : []));
  const transcript = handoffTranscript(
    repo.rootItems(source, ["user_message", "assistant_message", "tool_call"], TRANSCRIPT_ITEMS),
    source.worktreePath ?? source.cwd,
    // The task leads the transcript even when the newest items no longer reach back to it.
    requests[0],
  );
  const summary = (await deps.utility?.handoffSummary(transcript).catch(() => null)) ?? null;

  const now = repo.get(source.id);
  const late = handoffBlocker(now, repo.turnCount(source.id));
  if (late) throw late;
  if (repo.turnCount(source.id) !== turns) {
    throw conflict(
      "The session ran a turn while it was being handed off. Hand it off again.",
      "source_changed",
    );
  }
  const brief = buildHandoffBrief({
    session: now,
    providerName: providerName(runner, now.provider),
    restored: checkpoint !== null,
    // No turn ran since they were read (checked above), so the source's messages are the same.
    requests,
    lastReply: lastReply(repo, now),
    todos: latestTodos(repo, now),
    lastTurn: lastRootTurn(repo, now),
    edits: repo.fileEdits(now.id),
    summary,
    note: req.note,
  });
  return handoffPlan(now, project, target, checkpoint, brief, req);
}

/**
 * The new session: the source's project, work, issue, autonomy and plan mode, started by the
 * user on `target`, with the model and effort asked for (else the source's on the same provider,
 * else the provider's defaults). Its worktree is made like a fork's: a new branch from the
 * source's branch with `checkpoint` restored, the pull request targeting the source's base
 * branch, and the plan kept with its start metadata until the worktree exists. No §8.4 conflict
 * check: it is a deliberate, visible continuation (`forkedFrom`, kind `handoff`).
 */
export function handoffPlan(
  source: Session,
  project: Project,
  target: ProviderInfo,
  checkpoint: number | null,
  brief: string,
  req: HandoffSessionRequest,
): HandoffPlan {
  const same = target.id === source.provider;
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    projectId: project.id,
    role: "agent",
    parentSessionId: null,
    startedBy: { kind: "user" },
    purpose: source.purpose,
    workKey: source.workKey,
    scope: source.scope,
    progress: null,
    title: req.title ?? handoffTitle(source, target.displayName),
    provider: target.id,
    model: req.model ?? (same ? source.model : null),
    effort: req.effort ?? (same ? source.effort : null),
    autonomy: source.autonomy,
    planMode: source.planMode ?? false,
    status: "starting",
    cwd: project.path,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    issue: source.issue,
    pr: null,
    resumeToken: null,
    // The source's checkpoint lives on its runner: the new session runs there.
    runnerId: source.runnerId,
    automationRunId: null,
    rootThreadId: null,
    forkedFrom: { sessionId: source.id, checkpoint, kind: "handoff" },
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const start: ForkStart = {
    workspace: { mode: "worktree", baseRef: source.branch ?? undefined, fetch: false },
    fork: {
      baseBranch: source.baseBranch ?? project.defaultBranch ?? null,
      ...(checkpoint === null
        ? {}
        : { restoreCheckpoint: { sessionId: source.id, index: checkpoint } }),
    },
  };
  const input: UserInput = { text: brief, attachments: [], from: "codeden" };
  return {
    session,
    start,
    meta: {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
      forkStart: start,
      // Kept until a start delivers it, so a first start that fails doesn't lose it.
      handoffBrief: input,
    },
  };
}

/**
 * The input that opens a handoff (§9) whose brief is still to be delivered: the brief alone,
 * or with the message that starts the session after its first start failed (that message's
 * attachments kept). The brief comes first, so the agent reads the context before the request.
 */
export function withHandoffBrief(brief: UserInput, input: UserInput | undefined): UserInput {
  if (!input) return brief;
  const from = input.from && input.from !== "user" ? ` (from ${input.from})` : "";
  return {
    ...input,
    text: `${brief.text}\n\n## The latest message${from}\n\n${input.text}`,
    from: "codeden",
  };
}

/** The source's project, unless it is archived. */
function handoffProject(projects: ProjectService, source: Session): Project {
  if (!source.projectId) {
    throw badRequest("Only agent sessions can be handed off", "fork_unsupported");
  }
  const project = projects.get(source.projectId);
  if (project.archivedAt) throw badRequest("The project is archived", "project_archived");
  return project;
}

/**
 * The provider the work continues on, as the source's runner loads it, once it can take the
 * source's permissions: read-only needs native enforcement, and a session still planning needs
 * plan mode (§11.2), so neither is quietly dropped.
 */
function targetProvider(runner: RunnerPort, source: Session, id: string): ProviderInfo {
  const target = runner.providers().find((p) => p.id === id);
  if (!target) throw badRequest(`Provider ${id} is not available`, "unknown_provider");
  const readOnly = readOnlyUnsupported("agent", source.autonomy, target);
  if (readOnly) {
    throw badRequest(
      `${readOnly}. Change this session's permissions first.`,
      "read_only_unsupported",
    );
  }
  if (source.planMode && planModeUnsupported("agent", target)) {
    throw badRequest(
      `${target.displayName} has no plan mode, and this session is still planning. Approve or leave its plan first.`,
      "plan_mode_unsupported",
    );
  }
  return target;
}

function providerName(runner: RunnerPort, id: string): string {
  return runner.providers().find((p) => p.id === id)?.displayName ?? id;
}

function lastReply(repo: SessionRepo, session: Session): string | null {
  const replies = repo.rootItems(session, ["assistant_message"], 5);
  for (const item of replies.reverse()) {
    if (item.kind === "assistant_message" && item.text.trim()) return item.text;
  }
  return null;
}

function latestTodos(repo: SessionRepo, session: Session) {
  const [item] = repo.rootItems(session, ["todo_list"], 1);
  return item?.kind === "todo_list" ? item : null;
}

function lastRootTurn(repo: SessionRepo, session: Session) {
  const id = repo.rootTurnIds(session).at(-1);
  return id ? repo.turn(session.id, id) : null;
}
