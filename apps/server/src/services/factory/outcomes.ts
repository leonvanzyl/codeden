import type { FactoryFailureKind, FactoryItem, FactoryLoop } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, factoryNotice, pauseLoop, raiseInbox } from "./context";
import { escalatedInboxId } from "./merge";
import { shouldPause } from "./policy";
import { isDarkFactory, raiseStuck, recordStuckDecision } from "./stuck";

const AUDIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Mark an item failed and count it; pauses the loop after too many failures in a row. `kind`
 * says why (`checks` by default): an `infrastructure` failure (outside the item's code) never
 * counts towards the pause, and the loop puts it back by itself once the cause is gone
 * (`recover.ts`).
 */
export function failItem(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
  /** `countsAsFailure: false` keeps it out of the failure streak that pauses the loop. */
  opts: { countsAsFailure?: boolean; notify?: boolean; kind?: FactoryFailureKind } = {},
): FactoryLoop {
  const at = ctx.now().toISOString();
  const kind = opts.kind ?? "checks";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "failed",
    reason,
    failureKind: kind,
    note: null,
    finishedAt: at,
  }));
  if (opts.notify !== false) {
    factoryNotice(ctx, {
      id: `factory.failed:${item.id}`,
      projectId: item.projectId,
      target: "pm",
      event: "failed",
      title: `Factory item failed: ${item.title}`,
      text:
        kind === "infrastructure"
          ? `${reason}. This is outside its code: the factory puts it back by itself once the cause is gone.`
          : reason,
      itemIds: [item.id],
      wake: false,
    });
  }
  if (opts.countsAsFailure === false || kind !== "checks") return loop;
  const next = { ...loop, consecutiveFailures: loop.consecutiveFailures + 1 };
  const project = ctx.projects.get(item.projectId);
  if (shouldPause(next.consecutiveFailures, project.factoryLimits)) {
    return pauseLoop(
      ctx,
      next,
      `${next.consecutiveFailures} failed merge checks or reverts in a row`,
      {
        inbox: true,
        items: [item],
      },
    );
  }
  return next;
}

/**
 * A protected area was touched: hand the PR to a human and never merge it. Truly stuck
 * (`failureKind: stuck`), so one of the few things that reach the PM and the inbox (a recorded
 * decision, in a dark factory). The loop still owns the PR: it keeps it free of conflicts until
 * a person merges or closes it.
 */
export function escalate(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  checks: FactoryItem["checks"],
): FactoryLoop {
  const why = checks.find((c) => c.escalate)?.detail ?? "Needs a human";
  const current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "escalated",
    reason: why,
    failureKind: "stuck",
    note: null,
    finishedAt: ctx.now().toISOString(),
  }));
  const keep = "Until then the factory keeps the pull request free of merge conflicts.";
  if (isDarkFactory(ctx, item.projectId)) {
    recordStuckDecision(ctx, current, {
      question: `Merge pull request #${item.pr?.number ?? "?"} (${item.title}), which touches a protected area?`,
      decision: "Left for you: the factory never merges changes to protected areas",
      why: `${why}. ${keep}`,
    });
  } else {
    raiseInbox(ctx, {
      id: escalatedInboxId(item.id),
      kind: "pr_review",
      notify: "needs_you",
      priority: "high",
      projectId: item.projectId,
      sessionId: item.builderSessionId,
      issue: item.issue,
      pr: item.pr,
      title: `Factory PR needs you: ${item.title}`,
      body: `${why}. The factory never merges changes to protected areas; review and merge it yourself or close it. ${keep}`,
    });
  }
  factoryNotice(ctx, {
    id: `factory.escalated:${item.id}`,
    projectId: item.projectId,
    target: "pm",
    event: "escalated",
    title: `Escalated to the user: ${item.title}`,
    text: why,
    itemIds: [item.id],
  });
  return loop;
}

/**
 * The item is truly stuck (it used its rebuild, or CI can never run): it fails as `stuck`,
 * which never counts towards the pause, and the user and the PM hear about it.
 */
export function markStuck(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
  action: string,
): FactoryLoop {
  const next = failItem(ctx, loop, item, reason, { kind: "stuck", notify: false });
  raiseStuck(ctx, ctx.store.item(item.id) ?? item, reason, action);
  return next;
}

/** Run the project's audit command (security/dependency scan) in the builder's worktree. */
export async function runAudit(
  ctx: FactoryContext,
  command: string,
  cwd: string,
): Promise<{ ok: boolean; detail: string }> {
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
  if (!cmd) return { ok: true, detail: "no audit command" };
  try {
    const res = await ctx.exec(cmd, args, { cwd, timeoutMs: AUDIT_TIMEOUT_MS });
    if (res.notFound) return { ok: false, detail: `${cmd} is not installed` };
    if (res.timedOut) return { ok: false, detail: "the audit timed out" };
    const tail = `${res.stdout}\n${res.stderr}`
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    return res.code === 0
      ? { ok: true, detail: `\`${command}\` passed` }
      : { ok: false, detail: tail || `exit ${res.code}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}
