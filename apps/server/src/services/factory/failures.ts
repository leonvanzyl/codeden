import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { failedChecks, notAuthorFixable } from "./checks";
import { type FactoryContext, factoryNotice } from "./context";
import { failItem, markStuck } from "./outcomes";
import { fixPrompt, tooLargePrompt } from "./prompts";
import { MERGE_QUEUED } from "./queue";

/**
 * Failed merge checks (§10.1, Review and revise): a revise round when one is allowed, the
 * PM's call when the work is too large, otherwise the item fails. CI that never started is no
 * code problem: it is stuck when CI can never run on the repository, and an infrastructure
 * failure (recovered by itself) otherwise.
 */

/** Fail the review check with `reason`, then handle it like any failed check. */
export function failReview(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
): Promise<FactoryLoop> {
  const at = ctx.now().toISOString();
  const current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    checks: i.checks.map((c) =>
      c.name === "review" ? { ...c, state: "fail" as const, detail: reason, at } : c,
    ),
  }));
  return handleFailure(ctx, project, loop, current);
}

/**
 * Failed checks: a revise round if allowed, otherwise the item fails (and may pause). A builder
 * session that died is resumed by the revise message; only one a person stopped ends it.
 */
export async function handleFailure(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  /** The base branch, when the PR also has merge conflicts with it. */
  conflictsWith: string | null = null,
): Promise<FactoryLoop> {
  const failed = failedChecks(item.checks);
  // A revise round can't make work smaller without cutting scope: the PM splits or allows it.
  if (failed.some((c) => c.name === "size")) return tooLarge(ctx, project, loop, item);
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  const fixable =
    failed.some((c) => !notAuthorFixable(c)) &&
    item.attempts < loop.tuning.maxFixAttempts &&
    builder !== undefined &&
    builder.status !== "stopped" &&
    item.review?.verdict !== "reject";
  if (fixable && builder) {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => {
      const { ready: _ready, [MERGE_QUEUED]: _queued, ...nudges } = i.nudges;
      return {
        ...i,
        stage: "building",
        attempts: i.attempts + 1,
        review: null,
        note: `Revise round ${i.attempts + 1}: ${failed.map((c) => c.name).join(", ")}`,
        nudges: {
          ...nudges,
          [`fix_${i.attempts + 1}`]: at,
          ...(i.reviewerSessionId ? { rereview_pending: at } : {}),
        },
      };
    });
    await ctx.sessions.message(builder.id, fixPrompt(item, failed, conflictsWith));
    return loop;
  }
  if (failed.length > 0 && failed.every(notAuthorFixable)) return ciNeverStarted(ctx, loop, item);
  const reason =
    failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "Merge checks failed";
  const next = failItem(ctx, loop, item, reason);
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `The CodeDen factory's checks failed, so this PR is left for a human:\n\n${failed.map((c) => `- **${c.name}**: ${c.detail ?? "failed"}`).join("\n")}\n\nThe factory keeps it free of merge conflicts until it is merged or closed.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  return next;
}

/**
 * CI never started on the PR's head. With GitHub Actions off (or no active workflow) it never
 * will: the item is stuck and goes to the user. Otherwise it was a hiccup on GitHub's side: an
 * infrastructure failure the loop recovers by itself, starting CI again.
 */
async function ciNeverStarted(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const detail = item.checks.find((c) => c.name === "ci")?.detail ?? "CI never started";
  const actions = await ctx.github.actionsAvailable(item.projectId).catch(() => null);
  if (actions === false) {
    return markStuck(
      ctx,
      loop,
      item,
      `CI can never run on this repository: GitHub Actions are turned off, or no workflow is active (${detail})`,
      'Turn GitHub Actions (or the workflow) on and retry the item, or turn off "Require CI" in the factory settings.',
    );
  }
  return failItem(ctx, loop, item, `ci: ${detail}`, { kind: "infrastructure" });
}

/**
 * The size check failed. That isn't a quality failure, so it doesn't count towards pausing
 * the loop, and no revise round runs. The PM is woken to split the work into smaller issues
 * or, when it can't be split, to allow it with `factory_allow_large_change`. The PR stays open.
 */
async function tooLarge(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const failed = failedChecks(item.checks);
  const size = failed.find((c) => c.name === "size");
  const reason = failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ");
  const next = failItem(ctx, loop, item, reason, { countsAsFailure: false, notify: false });
  factoryNotice(ctx, {
    id: `factory.too-large:${item.id}:${item.pr?.number ?? ""}`,
    projectId: item.projectId,
    target: "pm",
    event: "failed",
    title: `Too large for the factory: ${item.title}`,
    text: tooLargePrompt(item, size?.detail ?? "over the size limit", failed),
    itemIds: [item.id],
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `This PR is larger than the CodeDen factory's size limit (${size?.detail ?? "over the limit"}). The project manager will split the work into smaller issues or allow it as one change.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  return next;
}
