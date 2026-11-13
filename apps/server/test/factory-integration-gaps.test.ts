import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * The integration step's guarantees (§10.1) on the paths that used to slip past them: a re-check
 * approves only the resolution it looked at, a failed rebuild leaves its original PR owned and
 * listed, restarting CI stays within the agent limit, and a protected area is recorded as stuck.
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
  review,
  keepConflicting,
  prEntry,
} = factorySteps(() => env);

const reviewCheck = (id: string) => item(id).checks.find((c) => c.name === "review");
const messagesTo = (sessionId: string) => env.messages.filter((m) => m.sessionId === sessionId);

describe("a re-check of a conflict resolution", () => {
  it.each(["after", "before"] as const)(
    "approves only the head it was asked about: a newer resolution waits for its own (loop sees it %s the verdict)",
    async (seen) => {
      env = createFactoryEnv();
      await enable();
      const { id, pr, builder } = await verifying("pending");
      review(id);
      await tick();
      const reviewer = item(id).reviewerSessionId as string;
      const approved = pr.headSha as string;

      // Resolution B: the reviewer is asked to re-check it.
      pr.mergeable = "conflicting";
      await tick();
      env.gh.rebase(pr, "resolvedB", "success");
      await env.setStatus(builder, "idle");
      await tick();
      expect(lastMessageTo(reviewer)).toContain(`git range-diff ${approved}...resolvedB`);

      // Main moves again before B's verdict: resolution C replaces it.
      pr.mergeable = "conflicting";
      await tick();
      expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);
      env.gh.rebase(pr, "resolvedC", "success");
      await env.setStatus(builder, "idle");
      if (seen === "before") await tick();

      // B's approval arrives: it says nothing about C, so C doesn't merge, and the reviewer
      // is asked to re-check C against B.
      review(id, { ...APPROVE, summary: "Resolution B keeps both sides" });
      await tick();
      await tick();
      expect(env.gh.merges).toEqual([]);
      expect(reviewCheck(id)?.state).toBe("pending");
      expect(lastMessageTo(reviewer)).toContain("git range-diff resolvedB...resolvedC");

      // C's own re-check approves: now it merges, on the earlier verdict.
      review(id, { ...APPROVE, summary: "Resolution C keeps both sides" });
      await tick();
      expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
      expect(item(id).review?.summary).toBe(APPROVE.summary);
    },
  );
});

describe("a rebuild that fails before its replacement PR exists", () => {
  it("leaves the original PR owned and listed", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    pr.mergeable = "conflicting";
    await tick();
    await keepConflicting(id);
    expect(item(id).rebuiltFrom?.number).toBe(pr.ref.number);
    const rebuilder = item(id).builderSessionId as string;
    expect(rebuilder).toBeTruthy();

    // The fresh builder stops before it opens a pull request: the rebuild failed. It used the
    // item's one rebuild, so the item is stuck with the user.
    await env.setStatus(rebuilder, "stopped");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "stuck" });
    expect(item(id).reason).toMatch(new RegExp(`rebuild of #${pr.ref.number} ended`));
    expect(env.inbox.find(`inbox:factory-stuck:${id}`)?.pr?.number).toBe(pr.ref.number);
    expect(env.gh.closed).toEqual([]);

    // The original PR is still the factory's: listed on the panel, and a person merging it
    // finishes the item.
    expect(await prEntry(pr.ref.number)).toMatchObject({ itemId: id, state: "stuck" });
    pr.ref = { ...pr.ref, state: "merged" };
    await tick();
    expect(item(id)).toMatchObject({ stage: "merged", failureKind: null });
    expect(env.inbox.find(`inbox:factory-stuck:${id}`)?.status).not.toBe("open");
  });
});

describe("restarting CI", () => {
  it("waits for a free agent before the builder pushes the empty commit", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 1 } });
    await enable();
    const { id, builder } = await verifying("none");
    const reviewer = item(id).reviewerSessionId as string;
    expect(env.repo.get(reviewer).status).toBe("running");
    later(2 * 60_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });

    // Back in verification; the reviewer holds the only agent slot, so the builder waits.
    const sent = messagesTo(builder).length;
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(messagesTo(builder).slice(sent)).toEqual([]);
    expect(item(id).note).toMatch(/waiting for a free agent/);

    // The reviewer's turn ends: the builder is asked to start CI again.
    await env.setStatus(reviewer, "idle");
    await tick();
    expect(lastMessageTo(builder)).toMatch(/empty commit/);
  });
});

describe("a protected-area escalation", () => {
  it("is recorded as stuck", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files: ["src/auth/login.ts", "test/login.test.ts"],
      checks: "pending",
    });
    await env.setStatus(builder, "idle");
    await tick();
    expect(item(created.id)).toMatchObject({ stage: "escalated", failureKind: "stuck" });
  });
});
