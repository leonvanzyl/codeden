import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #59: "bug issues appear to go down the feature path". A bug a person files is classified
 * and set up for the bug pipeline correctly, but in a dark factory it never gets an agent while
 * the scout keeps filing work: every issue the scout files outranks every issue a person files,
 * so the person only ever sees features being worked on.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const scoutSession = () =>
  env.repo.get(env.factory.data.loopOrNew(env.project.id).scout.sessionId as string);

describe("the queue of a dark factory (§10.1 Assign)", () => {
  it("gives the next free agent the bug a person filed before the scout's later features", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 1 } });
    env.factory.setMode(env.project.id, {
      mode: "dark_factory",
      limits: { ...env.project.factoryLimits, maxConcurrentSessions: 1 },
      tuning: { discoveryPerRound: 0, maxIssuesPerRound: 3 },
    });
    // The scout's round takes the only agent.
    await tick();
    const scout = scoutSession();
    expect(scout.workKey).toBe("factory:scout");

    // Meanwhile the owner files a bug. It is classified from its label and queued for the bug
    // pipeline: the type, the step and the lane are all right.
    const bug = env.gh.openIssue({
      projectId: env.project.id,
      title: "Opening brief shows raw Markdown",
      author: "codeden",
      labels: ["bug"],
    });
    await tick();
    expect(byIssue(bug.number)).toMatchObject({ stage: "backlog", type: "bug" });
    const queued = (await env.factory.status(env.project.id)).backlog.find(
      (w) => w.issue?.number === bug.number,
    );
    expect(queued).toMatchObject({ type: "bug", step: "queued" });

    // Then the scout files its features (no review areas: it reviews by itself).
    await env.factory.planRound(scout, { lenses: [] });
    for (const [title, priority] of [
      ["Archive finished sessions", "high"],
      ["Plan mode", "normal"],
    ] as const) {
      await env.factory.fileIssue(scout, {
        title,
        summary: `${title}, as the vision asks`,
        type: "feature",
        acceptanceCriteria: [`${title} works`],
        priority,
      });
    }

    // The scout's turn ends and its agent is free: the owner's bug, queued first, gets it.
    await env.setStatus(scout.id, "idle");
    await tick();
    const started = env.starts.at(-1);
    expect(started?.issue?.number, `started "${started?.purpose}"`).toBe(bug.number);
    expect(started?.purpose).toMatch(/^Factory \(bug\): /);
    expect(started?.input?.text).toContain("**Reproduce** (step 1)");
    expect(byIssue(bug.number).stage).toBe("building");
  });
});
