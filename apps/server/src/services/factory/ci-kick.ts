import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { startIntegrator } from "./integrator";
import { prGone } from "./pr-gone";
import { ciKickPrompt } from "./prompts-integration";
import { repairSlot, usablePrAgent } from "./rebase";
import { isBusy } from "./sessions";

/**
 * Starting CI again (§10.1, infrastructure failures). An item that failed because CI never
 * started, while GitHub Actions can run, goes back to verification with `ci_kick` set
 * (`recover.ts`), and the verify step carries the kick out, retrying until it happens:
 * - a PR behind the default branch is brought up to date on GitHub (a new head, no agent);
 * - otherwise its agent pushes an empty commit: the builder while its session exists, or a
 *   fresh integrator on the PR's head branch when it is gone or its start never reached its
 *   provider. Either waits for a free agent.
 * A conflicting PR needs none: the conflict flow rebases it, which makes a new head.
 */

/** The kick is still to come. */
const KICK = "ci_kick";
/** `ci_kicked_<sha>`: an agent was asked to push a new commit on top of that head. */
const KICKED = "ci_kicked_";

/** The nudge a recovery sets so the verify step starts CI again. */
export const CI_KICK_NUDGE = KICK;

function note(ctx: FactoryContext, item: FactoryItem, text: string, drop = false): void {
  ctx.store.updateItem(item.id, (i) => {
    const { [KICK]: _kick, ...rest } = i.nudges;
    return { ...i, note: text, nudges: drop ? rest : i.nudges };
  });
}

/**
 * Carry out a pending kick. True while CI shouldn't be timed out on this head yet: the kick
 * is still to come, or the agent asked for it is still at work on it.
 */
export async function kickCi(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<boolean> {
  const kicked = pr.headSha ? item.nudges[`${KICKED}${pr.headSha}`] : undefined;
  if (!item.nudges[KICK] && !kicked) return false;
  // The PR's agent, unless its start never reached its provider (`usablePrAgent`): one whose
  // start a provider refused never pushed this head's kick, so it is owed again, and a fresh
  // integrator pushes it on a provider that can take work.
  const usable = usablePrAgent(ctx, item);
  if ("awaiting" in usable) return true;
  const agent = usable.agent;
  if (kicked && usable.refused) {
    const at = ctx.now().toISOString();
    item = ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [KICK]: at } }));
  }
  if (!item.nudges[KICK]) return Boolean(kicked && agent && isBusy(agent));
  if (pr.checks !== "none" || pr.mergeable === "conflicting" || !pr.headSha) {
    // CI started meanwhile, or a rebase (which makes a new head) comes first.
    ctx.store.updateItem(item.id, (i) => {
      const { [KICK]: _kick, ...nudges } = i.nudges;
      return { ...i, nudges };
    });
    return false;
  }
  const sha = pr.headSha;
  try {
    if ((await ctx.github.behindBy(project.id, pr.ref.number, sha)) > 0) {
      await ctx.github.updateBranch(project.id, pr.ref.number, sha);
      note(
        ctx,
        item,
        "CI never started: updating the branch with the default branch to start it",
        true,
      );
      return true;
    }
  } catch (error) {
    note(ctx, item, `CI never started: could not update the branch (${errorMessage(error)})`);
    return true;
  }
  const at = ctx.now().toISOString();
  if (agent) {
    if (isBusy(agent)) return true;
    // Its turn holds an agent slot like any other the factory starts: wait for a free one,
    // after the reviews waiting for one (`slots.ts`).
    if (!repairSlot(ctx, project, item, agent)) {
      note(ctx, item, "CI never started: waiting for a free agent to push a commit that starts it");
      return true;
    }
    // Nothing for a PR that merged or closed since the step read it (`pr-gone.ts`).
    if (prGone(ctx, item)) return true;
    await ctx.sessions.message(agent.id, ciKickPrompt(item));
    ctx.store.updateItem(item.id, (i) => {
      const { [KICK]: _kick, ...nudges } = i.nudges;
      return {
        ...i,
        note: "CI never started: the author pushes an empty commit to start it",
        nudges: { ...nudges, [`${KICKED}${sha}`]: at },
      };
    });
    return true;
  }
  // The author's session is gone: an integrator takes the PR over and pushes the commit, on a
  // provider that can take work (it waits while none can).
  if (await startIntegrator(ctx, project, loop, item, pr, "ci", [`${KICKED}${sha}`])) {
    ctx.store.updateItem(item.id, (i) => {
      const { [KICK]: _kick, ...nudges } = i.nudges;
      return { ...i, nudges };
    });
  }
  return true;
}
