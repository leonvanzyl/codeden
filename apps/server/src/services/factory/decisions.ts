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
 * sessions. The earlier attempt's sessions are archived, so none is left behind.
 */
export function retry(ctx: FactoryContext, projectId: string, itemId: string): FactoryItem {
  const item = projectItem(ctx, projectId, itemId);
  if (item.stage !== "rejected" && item.stage !== "failed") {
    throw conflict(`Only stopped items can be retried (this one is ${item.stage})`, "not_stopped");
  }
  const earlier = sessionsToArchive(ctx, item).map((s) => s.id);
  const retried = ctx.store.updateItem(item.id, (i) => ({
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
    nudges: {},
    reason: null,
    note: "Retried",
    sessionsArchivedAt: null,
    finishedAt: null,
  }));
  // The earlier attempt is abandoned: a session still finishing its turn is stopped too.
  ctx.archiveSessions(earlier, { evenIfBusy: true });
  return retried;
}

/** `factory_submit_review`: the independent reviewer's structured verdict. */
export function submitReview(
  ctx: FactoryContext,
  session: Session,
  verdict: ReviewVerdict,
): { recorded: boolean; message: string } {
  const item = session.projectId
    ? ctx.store.items(session.projectId).find((i) => i.reviewerSessionId === session.id)
    : undefined;
  if (!item) throw badRequest("You are not reviewing a factory pull request", "not_a_reviewer");
  if (item.stage !== "verifying") {
    return {
      recorded: false,
      message: `Not recorded: the item is ${item.stage}${item.stage === "building" ? " (the author is revising it; you will be asked to review again)" : ""}.`,
    };
  }
  ctx.store.updateItem(item.id, (i) => {
    const { rereview_sent: _s, reviewer: _r, ...nudges } = i.nudges;
    return { ...i, review: verdict, nudges };
  });
  return { recorded: true, message: `Verdict recorded: ${verdict.verdict}.` };
}
