import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

/** A classified feature, waiting for an agent. */
function backlogItem(): FactoryItem {
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:3",
    title: "Add a counter",
    summary: "Users want to count things",
    source: "issue",
    stage: "backlog",
    type: "feature",
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 3, url: "https://github.com/acme/app/issues/3", title: "Add a counter" },
  });
}

// Issue #53: a session's opening brief was recorded without a sender, so the transcript showed
// the factory's long Markdown briefs as the user's plain text.
describe("the factory's opening briefs record their sender", () => {
  it("starts builders, reviewers, reverts, the scout and area reviewers as the factory", async () => {
    env = createFactoryEnv();
    const sessions = env.factory.ctx.sessions;
    const item = backlogItem();
    await sessions.startBuilder(item, "Ship a counter app", "claude");
    await sessions.startReviewer(item, "Ship a counter app", "codex", null, null, false);
    await sessions.startRevert(env.project.id, { sha: "abc1234def", prNumber: 7, title: "Bad" });
    await sessions.startScout(env.project.id, "## Round 1\n\nReview **everything**.");
    await sessions.startLens(env.project.id, "ux", "## UX\n\nReview the `ux`.");
    expect(env.starts).toHaveLength(5);
    for (const req of env.starts) {
      expect(req.input?.text.length, req.purpose).toBeGreaterThan(0);
      expect(req.input?.from, req.purpose).toBe("factory");
    }
  });
});
