import {
  type AutonomyMode,
  type FactoryItem,
  type FactoryTuningPatch,
  ReviewVerdict,
  type ReviewVerdictInit,
} from "@codeden/contracts";
import { expect } from "vitest";
import { OWNED_RECHECK_MS } from "../../src/services/factory/owned";
import type { FactoryEnv } from "./factory-env";
import type { FakePr } from "./fake-factory-github";

/** Steps the factory loop tests share: switch the mode on, build an item into verification, review it. */

export const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Counter increments", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

export function factorySteps(env: () => FactoryEnv) {
  const e = () => env();
  const item = (id: string) => e().factory.data.item(id) as FactoryItem;
  const tick = () => e().factory.tick(e().project.id);
  const later = (ms: number) => {
    e().clock.offsetMs += ms;
  };
  const lastMessageTo = (sessionId: string) =>
    e()
      .messages.filter((m) => m.sessionId === sessionId)
      .at(-1)?.text ?? "";

  /** The software or dark factory (the scout never runs on its own: `minBacklog` 0). */
  const enable = (
    mode: Extract<AutonomyMode, "software_factory" | "dark_factory"> = "software_factory",
    opts: { autoMerge?: boolean; tuning?: FactoryTuningPatch } = {},
  ) =>
    e().factory.setMode(e().project.id, {
      mode,
      limits: { ...e().project.factoryLimits, autoMerge: opts.autoMerge ?? true },
      tuning: { minBacklog: 0, ...opts.tuning },
    } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);

  /** A feature, already analyzed, waiting for an agent. */
  const backlogItem = (title = "Add a counter", issue = 3) =>
    e().factory.data.createItem({
      projectId: e().project.id,
      workKey: `issue:${issue}`,
      title,
      summary: "Users want to count things",
      source: "issue",
      stage: "backlog",
      type: "feature",
      investigation: {
        kind: "analysis",
        outcome: "implement",
        summary: "Missing",
        details: "A counter",
        testPath: null,
        at: new Date().toISOString(),
      },
      score: null,
      acceptanceCriteria: ["Counter increments"],
      issue: { number: issue, url: `https://github.com/acme/app/issues/${issue}`, title },
    });

  /** The builder (started for `id` by the last tick) opens its PR and ends its turn. */
  const openPr = async (id: string, checks: FakePr["checks"] = "success") => {
    const builder = item(id).builderSessionId as string;
    const pr = e().gh.openPr({
      sessionId: builder,
      title: item(id).title,
      files: ["src/counter.ts", "test/counter.test.ts"],
      checks,
    });
    await e().setStatus(builder, "idle");
    return { pr, builder };
  };

  /** A feature built until its PR is in verification. */
  const verifying = async (
    checks: FakePr["checks"] = "success",
    title?: string,
    issue?: number,
  ) => {
    const created = backlogItem(title, issue);
    await tick();
    const { pr, builder } = await openPr(created.id, checks);
    await tick();
    expect(item(created.id).stage).toBe("verifying");
    return { id: created.id, pr, builder };
  };

  /** The reviewer's verdict on the item. */
  const review = (id: string, verdict: ReviewVerdictInit = APPROVE) => {
    const session = e().repo.get(item(id).reviewerSessionId as string);
    return e().factory.submitReview(session, ReviewVerdict.parse(verdict));
  };

  /** Answer every rebase request with the conflicts still there, until the item leaves verification. */
  const keepConflicting = async (id: string) => {
    for (let n = 0; n < 4 && item(id).stage === "verifying"; n++) {
      await e().setStatus(item(id).builderSessionId as string, "idle");
      await tick();
    }
  };

  /** Mark the item failed, as after its revise rounds ran out. */
  const failed = (id: string) =>
    e().factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      reason: "review: request_changes: still has gaps",
      failureKind: "checks",
      finishedAt: new Date().toISOString(),
    }));

  /**
   * As if `OWNED_RECHECK_MS` had passed since the loop last read an owned item's PR (sessions
   * stamp real time, so the test clock isn't moved past the agent's turns).
   */
  const readAgainSoon = (id: string) => {
    const at = new Date(Date.now() - OWNED_RECHECK_MS - 1).toISOString();
    e().factory.data.updateItem(id, (i) => ({ ...i, nudges: { ...i.nudges, owned_checked: at } }));
  };

  /** The panel's entry for a PR. */
  const prEntry = async (prNumber: number) =>
    (await e().factory.status(e().project.id)).pullRequests.find((p) => p.pr.number === prNumber);

  return {
    item,
    tick,
    later,
    lastMessageTo,
    enable,
    backlogItem,
    openPr,
    verifying,
    review,
    keepConflicting,
    failed,
    readAgainSoon,
    prEntry,
  };
}
