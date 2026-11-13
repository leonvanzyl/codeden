import type { FactoryItem, FactoryLoop } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, factoryNotice, pauseLoop, raiseInbox } from "./context";
import { shouldPause } from "./policy";

const AUDIT_TIMEOUT_MS = 5 * 60_000;

/** Mark an item failed and count it; pauses the loop after too many failures in a row. */
export function failItem(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
  /** `countsAsFailure: false` keeps it out of the failure streak that pauses the loop. */
  opts: { countsAsFailure?: boolean; notify?: boolean } = {},
): FactoryLoop {
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "failed",
    reason,
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
      text: reason,
      itemIds: [item.id],
      wake: false,
    });
  }
  if (opts.countsAsFailure === false) return loop;
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

/** A protected area was touched: hand the PR to a human (inbox) and never merge it. */
export function escalate(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  checks: FactoryItem["checks"],
): FactoryLoop {
  const why = checks.find((c) => c.escalate)?.detail ?? "Needs a human";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "escalated",
    reason: why,
    note: null,
    finishedAt: ctx.now().toISOString(),
  }));
  raiseInbox(ctx, {
    id: `inbox:factory-escalated:${item.id}`,
    kind: "pr_review",
    notify: "needs_you",
    priority: "high",
    projectId: item.projectId,
    sessionId: item.builderSessionId,
    issue: item.issue,
    pr: item.pr,
    title: `Factory PR needs you: ${item.title}`,
    body: `${why}. The factory never merges changes to protected areas; review and merge it yourself or close it.`,
  });
  factoryNotice(ctx, {
    id: `factory.escalated:${item.id}`,
    projectId: item.projectId,
    target: "pm",
    event: "escalated",
    title: `Escalated to the user: ${item.title}`,
    text: why,
    itemIds: [item.id],
    wake: false,
  });
  return loop;
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
