import type { GitHubPrRef, Project, QueuedMessage, Session } from "@codeden/contracts";
import type { TranscriptState } from "./transcript/reducer";

/**
 * What the **Open PR** buttons send. In a session the user started, the agent opens a pull
 * request only when asked, so the button asks: the agent writes the title and description and
 * commits what is left with `create_pull_request`.
 */
export const OPEN_PR_PROMPT =
  "Open a pull request for this work with `create_pull_request`. Commit anything uncommitted first, and write a title and description that say what changed, why, and how it was tested.";

/** Whether a message is the **Open PR** buttons' request. */
export const isOpenPrPrompt = (text: string) => text.trim() === OPEN_PR_PROMPT;

/** A pull request that is still being worked on (open or draft), as opposed to merged or closed. */
export function isActivePr(pr: GitHubPrRef | null | undefined): pr is GitHubPrRef {
  return pr?.state === "open" || pr?.state === "draft";
}

/**
 * Whether the UI offers to ask this session's agent for a pull request: an agent session the user
 * started in a GitHub project, working on its own branch, that can still push (not read-only, not
 * archived) and has no open PR yet. Sessions CodeDen starts (PM, automation, factory) open their
 * own pull requests when their work is done. `pr` is the session's PR as GitHub reports it now,
 * when known; it defaults to the one recorded on the session.
 */
export function canAskForPullRequest(
  session: Session | null | undefined,
  project: Project | null | undefined,
  pr: GitHubPrRef | null | undefined = session?.pr,
): boolean {
  if (!session || project?.kind !== "github") return false;
  if (session.role !== "agent" || session.startedBy.kind !== "user") return false;
  if (session.autonomy === "read_only" || session.archivedAt) return false;
  if (!session.worktreePath || !session.branch || session.branch === session.baseBranch) {
    return false;
  }
  return !isActivePr(pr);
}

/** The root thread's latest user message, and whether the turn that carries it still runs. */
export interface LatestUserMessage {
  id: string;
  /** It is the **Open PR** request. */
  asksForPr: boolean;
  running: boolean;
}

export function latestUserMessage(
  transcript: TranscriptState | undefined,
): LatestUserMessage | null {
  const thread = transcript?.rootThreadId ? transcript.threads[transcript.rootThreadId] : undefined;
  if (!transcript || !thread) return null;
  for (let i = thread.itemIds.length - 1; i >= 0; i--) {
    const entry = transcript.items[thread.itemIds[i] ?? ""];
    if (entry?.item.kind !== "user_message") continue;
    return {
      id: entry.item.id,
      asksForPr: isOpenPrPrompt(entry.item.input.text),
      running: transcript.turns[entry.turnId]?.status === "running",
    };
  }
  return null;
}

/**
 * A request for a pull request this window just made, until the server shows it: `after` is the
 * root thread's latest user message when it was made (null when the transcript wasn't loaded).
 */
export interface PrAsk {
  after: string | null;
}

/**
 * Where the session's request for a pull request stands: `queued` behind the running turn, `sent`
 * (the turn that carries it runs, or the server is still taking it), or null when none is in
 * progress, so the buttons offer **Open PR** again once that turn ended without a PR.
 */
export type PrRequest = "queued" | "sent" | null;

export function pullRequestRequest(input: {
  /** The session's queued messages, when loaded. */
  queue: QueuedMessage[] | undefined;
  latest: LatestUserMessage | null;
  asked: PrAsk | undefined;
}): PrRequest {
  if (input.queue?.some((m) => isOpenPrPrompt(m.input.text))) return "queued";
  if (input.latest?.asksForPr && input.latest.running) return "sent";
  // Asked here and the transcript hasn't moved on yet: it is on its way to the queue or the agent.
  if (input.asked && (input.latest?.id ?? null) === input.asked.after) return "sent";
  return null;
}

/** What the Git bar, the Issue / PR tab and the Push toast offer for the session's PR. */
export interface PullRequestOffer {
  /** Offer **Open PR**: the session can ask and no request is in progress. */
  canAsk: boolean;
  /** A request in progress (shown as "PR requested"), for a session that could otherwise ask. */
  requested: PrRequest;
  /** The session's open or draft PR. */
  pr: GitHubPrRef | null;
}

export function pullRequestOffer(input: {
  session: Session | null | undefined;
  project: Project | null | undefined;
  /** The PR as GitHub reports it now, else the one recorded on the session. */
  pr: GitHubPrRef | null;
  /** False when GitHub reports the project's connection down. */
  connected: boolean;
  queue: QueuedMessage[] | undefined;
  latest: LatestUserMessage | null;
  asked: PrAsk | undefined;
}): PullRequestOffer {
  const eligible = input.connected && canAskForPullRequest(input.session, input.project, input.pr);
  const requested = eligible ? pullRequestRequest(input) : null;
  return {
    canAsk: eligible && !requested,
    requested,
    pr: isActivePr(input.pr) ? input.pr : null,
  };
}

/** Why the control says "PR requested", for its hover text. */
export function prRequestedHint(requested: "queued" | "sent"): string {
  return requested === "queued"
    ? "Queued behind the running turn: the agent opens the pull request when that turn ends"
    : "The agent is opening a pull request";
}
