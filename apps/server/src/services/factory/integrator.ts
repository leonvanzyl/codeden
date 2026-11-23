import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { builderWanted, chooseAgent } from "./agent-choice";
import { baseBranchOf, type FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { prGone } from "./pr-gone";
import { type IntegratorTask, integratorPrompt } from "./prompts-integration";
import { claimSlot } from "./slots";
import { FINISHED_STAGES } from "./store";

/**
 * A fresh integrator takes over the PR when the session that wrote it is gone (or never started,
 * `usablePrAgent` in `rebase.ts`): a worktree on the PR's head branch, a brief with the issue,
 * the PR description and the review history. It becomes the item's PR agent, so the PR's later
 * follow-ups (conflicts, CI, the audit, the review's worktree) go to it. Its provider and model
 * are chosen as the item's builder's are (`chooseAgent`): a provider the factory backed off is
 * skipped for an available one, and while none is available it waits with the waiting note,
 * holding no slot. Then it waits for a free agent slot; true once it started. `marks` are nudges
 * recorded when it starts. None starts for a PR that merged or closed since the step read it
 * (`pr-gone.ts`).
 */
export async function startIntegrator(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
  task: IntegratorTask,
  marks: string[],
): Promise<boolean> {
  if (prGone(ctx, item)) return false;
  const base = baseBranchOf(project);
  const what =
    task === "conflicts"
      ? `Merge conflicts with ${base}`
      : "CI never started on its head and its author's session is gone";
  const agent = chooseAgent(ctx, project, builderWanted(item, loop.tuning), "integration");
  if ("waiting" in agent) {
    if (item.note !== agent.waiting) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, note: agent.waiting }), { touch: false });
    }
    return false;
  }
  if (!claimSlot(ctx, project, "repair", `repair:${item.id}`)) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `${what}: waiting for a free agent to take the pull request over`,
    }));
    return false;
  }
  const res = await ctx.sessions.startIntegrator(
    item,
    { number: pr.ref.number, headBranch: pr.headBranch },
    integratorPrompt(
      item,
      { number: pr.ref.number, url: pr.ref.url, body: pr.body, headBranch: pr.headBranch },
      base,
      task,
    ),
    agent,
  );
  if (res.status !== "started") {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `${what}: the integrator could not start (${res.status})`,
    }));
    return false;
  }
  const session = ctx.repo.find(res.sessionId)?.session;
  const chosen = agent.provider === "auto" ? null : agent.provider;
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    builderSessionId: res.sessionId,
    builderProvider: session?.provider ?? chosen ?? i.builderProvider,
    note: `${what}: an integrator took the pull request over`,
    nudges: { ...i.nudges, ...Object.fromEntries(marks.map((k) => [k, at])) },
    // Finished work's integrator is archived again once its turn is over.
    sessionsArchivedAt: FINISHED_STAGES.includes(i.stage) ? null : i.sessionsArchivedAt,
  }));
  return true;
}
