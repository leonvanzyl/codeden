import type { FactoryLimits, Project } from "@codeden/contracts";
import { badRequest, conflict } from "../errors";
import type { FactoryContext } from "./context";
import { hasBudget } from "./policy";
import { readVision } from "./vision";

/** Switching modes and the kill switch (§10.1). */

/**
 * The software and dark factory need a GitHub project, a vision file and limits with a daily
 * budget (sent with the switch, or saved while already in a factory mode).
 */
export function assertCanEnter(
  ctx: FactoryContext,
  project: Project,
  opts: { limitsSent: boolean; wasFactory: boolean; limits: FactoryLimits },
): void {
  if (!ctx.github.isGithubProject(project.id)) {
    throw conflict("The software and dark factory need a GitHub project", "not_a_github_project");
  }
  if (!readVision(project).exists) {
    throw conflict(`Write the project vision (${project.visionPath}) first`, "vision_required");
  }
  if (!opts.limitsSent && !opts.wasFactory) {
    throw badRequest("Set the factory limits when switching to this mode", "limits_required");
  }
  if (!hasBudget(opts.limits)) {
    throw badRequest("The limits need a daily budget (usd or tokens)", "budget_required");
  }
}

/**
 * The kill switch: stop every factory session of the project, put work that hadn't opened a
 * PR back in the queue, close the scout's round and stop the loop. Returns the stopped ids.
 */
export async function haltProject(ctx: FactoryContext, projectId: string): Promise<string[]> {
  const stopped = await ctx.sessions.stopAll(projectId);
  for (const item of ctx.store.items(projectId, ["building", "verifying"])) {
    ctx.store.updateItem(item.id, (i) =>
      i.stage === "building" && !i.pr
        ? { ...i, stage: "backlog", builderSessionId: null, note: "Stopped by the kill switch" }
        : {
            ...i,
            reviewerSessionId: i.review ? i.reviewerSessionId : null,
            note: "Stopped by the kill switch",
          },
    );
  }
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  ctx.store.saveLoop({ ...loop, state: "stopped", scout: { ...loop.scout, round: null } });
  return stopped;
}
