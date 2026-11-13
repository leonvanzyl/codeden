import type {
  Classification,
  FactoryAdmitRequest,
  FactoryItem,
  FactorySetTypeRequest,
  ReviewVerdict,
  Session,
} from "@codeden/contracts";
import { badRequest, conflict, notFound } from "../errors";
import { sessionsToArchive } from "./cleanup";
import type { FactoryContext } from "./context";
import { announceType } from "./intake";
import { lateReviewPrompt } from "./prompts";
import { trackedHead } from "./rebase";
import { ownershipAfterRetry } from "./rebuild";
import { approveRecheck, recheckOf, recheckSentFor, withoutRecheck } from "./recheck";
import { environmentBlocked, environmentOnly, withoutStrikes } from "./review-environment";

/**
 * Decisions on work items (§10.1): letting an untrusted issue in, correcting a type, retrying
 * work that stopped, and the independent reviewer's verdict. Each records data the state
 * machine acts on.
 */

/** Who made a decision: you (the UI) or the PM (at your request). */
export type DecidedBy = "user" | "pm";

function projectItem(ctx: FactoryContext, projectId: string, itemId: string): FactoryItem {
  const item = ctx.store.item(itemId);
  if (!item || item.projectId !== projectId)
    throw notFound(`No factory item ${itemId}`, "item_not_found");
  return item;
}

function chosen(
  ctx: FactoryContext,
  type: Classification["type"],
  by: DecidedBy,
  rationale: string,
): Classification {
  return { type, confidence: "high", rationale, by, at: ctx.now().toISOString() };
}

/**
 * Let an ignored issue from an untrusted author in. It is classified (or takes the type given)
 * and runs through its pipeline like any other, but it is never merged automatically: a person
 * merges it, whatever the auto-merge setting says.
 */
export async function admit(
  ctx: FactoryContext,
  projectId: string,
  req: FactoryAdmitRequest,
  by: DecidedBy,
): Promise<FactoryItem> {
  const item = projectItem(ctx, projectId, req.itemId);
  if (item.stage !== "ignored") {
    throw conflict(`Item ${item.id} is ${item.stage}, not ignored`, "not_ignored");
  }
  const who = by === "user" ? "you" : "the PM";
  const classification = req.type
    ? chosen(ctx, req.type, by, `Type chosen by ${who} when letting it in`)
    : null;
  const admitted = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: classification ? "backlog" : "candidate",
    trust: "admitted",
    admittedBy: by,
    type: classification?.type ?? i.type,
    classification: classification ?? i.classification,
    reason: null,
    note: `Let in by ${who}; a person merges it`,
    finishedAt: null,
  }));
  if (classification) await announceType(ctx, projectId, admitted, classification);
  return admitted;
}

/** Correct the type of an item that hasn't started yet; it moves to that pipeline. */
export async function setType(
  ctx: FactoryContext,
  projectId: string,
  req: FactorySetTypeRequest,
  by: DecidedBy,
): Promise<FactoryItem> {
  const item = projectItem(ctx, projectId, req.itemId);
  if (item.stage !== "candidate" && item.stage !== "backlog") {
    throw conflict(`Item ${item.id} has already started (${item.stage})`, "already_started");
  }
  if (item.trust === "untrusted") {
    throw conflict("Let the issue in first", "untrusted");
  }
  const who = by === "user" ? "you" : "the PM";
  const classification = chosen(ctx, req.type, by, req.reason ?? `Set by ${who}`);
  const updated = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "backlog",
    type: req.type,
    classification,
    investigation: null,
    note: null,
  }));
  if (item.type !== req.type) await announceType(ctx, projectId, updated, classification);
  return updated;
}

/**
 * Run an item that stopped (not reproduced, declined, failed checks, closed) again, with fresh
 * sessions. The earlier attempt's sessions go to `earlierSessionIds`, which the loop archives
 * once none of them is busy, so none is left behind. If they were archived already, nothing
 * is: a session someone restored since stays.
 */
export function retry(ctx: FactoryContext, projectId: string, itemId: string): FactoryItem {
  const item = projectItem(ctx, projectId, itemId);
  if (item.stage !== "rejected" && item.stage !== "failed") {
    throw conflict(`Only stopped items can be retried (this one is ${item.stage})`, "not_stopped");
  }
  const earlier = item.sessionsArchivedAt ? [] : sessionsToArchive(ctx, item).map((s) => s.id);
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: i.type ? "backlog" : "candidate",
    investigation: null,
    attempts: 0,
    review: null,
    checks: [],
    pr: null,
    builderSessionId: null,
    builderProvider: null,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    // Its PRs stay owned: the open one and any still to be closed are closed, with a link,
    // once the new attempt's PR is open.
    nudges: ownershipAfterRetry(ctx, i),
    reason: null,
    failureKind: null,
    note: "Retried",
    sessionsArchivedAt: null,
    earlierSessionIds: [...new Set([...i.earlierSessionIds, ...earlier])],
    finishedAt: null,
  }));
}

/**
 * `factory_submit_review`: the independent reviewer's structured verdict. A verdict that comes
 * late is kept too: while a revise round runs, its findings are `forward`ed to the author (the
 * caller sends them); on a failed item it is recorded for whoever picks the work up. A request
 * for changes that only the reviewer's own environment stands behind is never recorded or
 * forwarded (`review-environment.ts`).
 */
export function submitReview(
  ctx: FactoryContext,
  session: Session,
  verdict: ReviewVerdict,
): { recorded: boolean; message: string; forward?: { sessionId: string; text: string } } {
  const item = session.projectId
    ? ctx.store.items(session.projectId).find((i) => i.reviewerSessionId === session.id)
    : undefined;
  if (!item) throw badRequest("You are not reviewing a factory pull request", "not_a_reviewer");
  // Only the reviewer's own environment stands behind it: no cause in the PR (#206).
  if (environmentOnly(verdict) && (item.stage === "verifying" || item.stage === "building")) {
    return environmentBlocked(ctx, item);
  }
  if (item.stage === "building" && item.builderSessionId && verdict.verdict !== "approve") {
    return {
      recorded: true,
      message:
        "Passed to the author, who is already revising the pull request; you will be asked to review it again.",
      forward: { sessionId: item.builderSessionId, text: lateReviewPrompt(item, verdict) },
    };
  }
  if (item.stage === "failed") {
    ctx.store.updateItem(item.id, (i) => ({ ...i, review: verdict }));
    return {
      recorded: true,
      message: `Verdict recorded on the failed item (${verdict.verdict}); it stays with the pull request for whoever picks it up.`,
    };
  }
  if (item.stage !== "verifying") {
    return {
      recorded: false,
      message: `Not recorded: the item is ${item.stage}${item.stage === "building" ? " (the author is revising it; you will be asked to review again)" : ""}.`,
    };
  }
  // A re-check of a conflict resolution: an approval keeps the earlier verdict, and answers only
  // for the head it was asked about (the verify step settles it against the PR's head). Any
  // other verdict replaces the earlier one, and nothing is owed any more.
  const recheck = Boolean(item.review && recheckOf(item));
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => {
    const { rereview_sent: _s, reviewer: _r, ...rest } = withoutStrikes(i.nudges);
    const keep = recheck && verdict.verdict === "approve" && i.review;
    return {
      ...i,
      review: keep ? i.review : verdict,
      nudges: keep ? approveRecheck(rest, at) : withoutRecheck(rest),
    };
  });
  return {
    recorded: true,
    message: recheck ? recheckRecorded(item, verdict) : `Verdict recorded: ${verdict.verdict}.`,
  };
}

/** What the reviewer is told about its re-check verdict. */
function recheckRecorded(item: FactoryItem, verdict: ReviewVerdict): string {
  if (verdict.verdict !== "approve") return `Re-check recorded: ${verdict.verdict}.`;
  const head = recheckSentFor(item);
  if (!head) {
    return "Re-check recorded: approve. It isn't known which head it covers, so you will be asked to re-check the current head before it merges.";
  }
  if (head === trackedHead(item)) return "Re-check recorded: approve. Your earlier verdict stands.";
  return `Re-check recorded: approve of ${head.slice(0, 7)}. The pull request has a newer head than the one you were asked about, so you will be asked to re-check that too before it merges.`;
}
