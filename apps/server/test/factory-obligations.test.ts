import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * What an item still owes survives every transition that starts it afresh (§10.1): a conflict
 * resolution the reviewer hasn't re-checked survives an infrastructure failure and its
 * recovery (it never merges on the old approval), and the PRs a retry replaces stay owned
 * until they are closed with a link to the new one.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const {
  item,
  tick,
  later,
  lastMessageTo,
  enable,
  backlogItem,
  verifying,
  openPr,
  review,
  failed,
  readAgainSoon,
  prEntry,
} = factorySteps(() => env);

const reviewCheck = (id: string) => item(id).checks.find((c) => c.name === "review");

describe("a re-check owed across an infrastructure failure", () => {
  it.each(["reviewer", "ci"] as const)(
    "never merges until a re-check of the resolution approves (%s failure)",
    async (cause) => {
      env = createFactoryEnv();
      await enable();
      const { id, pr, builder } = await verifying("pending");
      review(id);
      await tick();
      const oldHead = pr.headSha as string;
      pr.mergeable = "conflicting";
      await tick();
      // The builder resolves the conflicts; the approval waits for the re-check.
      env.gh.rebase(pr, "resolved1", cause === "ci" ? "none" : "success");
      await env.setStatus(builder, "idle");
      await tick();
      expect(item(id).nudges[`recheck_${oldHead}`]).toBeDefined();
      expect(reviewCheck(id)?.state).toBe("pending");

      if (cause === "reviewer") {
        // Every reviewer that takes the re-check dies, until the item fails for it.
        for (let n = 1; n <= 4; n++) {
          await env.setStatus(item(id).reviewerSessionId as string, "failed");
          await tick();
          if (n < 4) {
            await tick();
            expect(env.starts.at(-1)?.input?.text).toContain(
              `git range-diff ${oldHead}...resolved1`,
            );
          }
        }
      } else {
        // CI never starts on the resolved head.
        later(2 * 60_000);
        await tick();
      }
      expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
      expect(item(id).nudges[`recheck_${oldHead}`]).toBeDefined();

      // Recovered: the re-check is still owed, so the old approval doesn't merge it.
      await tick();
      expect(item(id).stage).toBe("verifying");
      expect(item(id).nudges[`recheck_${oldHead}`]).toBeDefined();
      expect(item(id).review?.summary).toBe(APPROVE.summary);
      expect(reviewCheck(id)?.state).toBe("pending");
      const rechecker = item(id).reviewerSessionId as string;
      expect(rechecker).toBeTruthy();
      const asked =
        cause === "reviewer" ? (env.starts.at(-1)?.input?.text ?? "") : lastMessageTo(rechecker);
      expect(asked).toContain(`git range-diff ${oldHead}...resolved1`);
      if (cause === "ci") pr.checks = "success";
      await tick();
      await tick();
      expect(env.gh.merges).toEqual([]);

      // Only the re-check's verdict lets it merge.
      review(id, { ...APPROVE, summary: "The resolution keeps both sides" });
      await tick();
      expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
      expect(item(id).review?.summary).toBe(APPROVE.summary);
    },
  );
});

describe("a retried item's PRs", () => {
  it("stay owned and are closed, with a link, once the new attempt's PR is open", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem();
    await tick();
    const id = created.id;
    const builder = item(id).builderSessionId as string;
    const files = ["src/a.ts", "test/a.test.ts"];
    const first = env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files,
      checks: "pending",
    });
    await env.setStatus(builder, "idle");
    await tick();
    failed(id);

    // Its author is gone; an integrator resolves its conflicts on a new PR, and GitHub refuses
    // to close the old one.
    env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
    first.mergeable = "conflicting";
    readAgainSoon(id);
    await tick();
    const integrator = item(id).builderSessionId as string;
    // CI still runs on it, so the failed item isn't re-reviewed by itself yet (#259).
    const second = env.gh.openPr({
      sessionId: integrator,
      title: "Add a counter",
      files,
      checks: "pending",
    });
    env.gh.closeFailures = 1;
    await env.setStatus(integrator, "idle");
    await tick();
    expect(item(id).pr?.number).toBe(second.ref.number);
    expect(env.gh.closeAttempts).toBe(1);
    expect(item(id).nudges[`supersede_${first.ref.number}`]).toBeDefined();

    // A person retries the item as a rebuild: both PRs stay tracked while the new attempt builds.
    env.factory.retry(env.project.id, id, "rebuild");
    await tick();
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", pr: null });
    expect(env.gh.closeAttempts).toBe(1);
    for (const pr of [first, second]) {
      expect(await prEntry(pr.ref.number)).toMatchObject({
        itemId: id,
        state: "superseded",
        note: expect.stringMatching(/closes once the new pull request is open/),
      });
    }

    const { pr: third } = await openPr(id, "pending");
    await tick();
    expect(item(id).pr?.number).toBe(third.ref.number);
    expect(env.gh.closed.map((c) => c.number).sort()).toEqual(
      [first.ref.number, second.ref.number].sort(),
    );
    for (const c of env.gh.closed) {
      expect(c.comment).toContain(`Superseded by #${third.ref.number}`);
    }
    expect(await prEntry(first.ref.number)).toBeUndefined();
    expect(await prEntry(second.ref.number)).toBeUndefined();
  });
});
