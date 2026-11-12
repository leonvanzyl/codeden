import { REVIEW_SUMMARY_MAX, ReviewVerdict } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AnyServerTool, defineTool } from "../src/mcp/define";
import { describeTool, ToolRegistry } from "../src/mcp/registry";
import { factorySubmitReview } from "../src/mcp/tools/factory/builder";
import { reReviewPrompt, reviewerPrompt } from "../src/services/factory/prompts";

/**
 * `factory_submit_review` (§10.1, issue #82): a verdict must never be lost over its length,
 * a rejected call must say how to fix it, and the reviewer must be allowed to call again.
 */

const REVIEWER = "reviewer-1";

/** A registry with the review tool, over services that record what reached the factory. */
function reviewTool(extra: AnyServerTool[] = []) {
  const submitted: ReviewVerdict[] = [];
  const session = { id: REVIEWER, projectId: "p1", workKey: "factory:review:i1" };
  const services = {
    sessionRepo: {
      find: (id: string) => (id === REVIEWER ? { session } : undefined),
      get: () => session,
    },
    factory: {
      submitReview: (_session: unknown, verdict: ReviewVerdict) => {
        submitted.push(verdict);
        return { recorded: true, message: `Verdict recorded: ${verdict.verdict}.` };
      },
    },
  };
  const registry = new ToolRegistry([factorySubmitReview, ...extra], services as never);
  const call = (name: string, args: unknown) =>
    registry.call(name, args, {
      role: "agent",
      sessionId: REVIEWER,
      projectId: "p1",
      caller: "mcp",
      signal: new AbortController().signal,
    });
  return { call, submitted };
}

const verdict = (summary: string) => ({
  verdict: "request_changes",
  summary,
  criteria: [{ criterion: "The bug is fixed", met: false, note: "Only one of two paths" }],
  vision: { aligned: true },
  tests: { adequate: false, note: "No regression test" },
  security: { concerns: [] },
});

describe("factory_submit_review summary length", () => {
  it("records a verdict whose summary is longer than 4,000 characters", async () => {
    const { call, submitted } = reviewTool();
    const summary = `Five defects. ${"x".repeat(5_200)}`;
    const res = await call("factory_submit_review", verdict(summary));
    expect(res.isError, res.text).toBe(false);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.summary).toBe(summary);
  });

  it("stores an over-long summary truncated with a marker instead of losing the verdict", async () => {
    const { call, submitted } = reviewTool();
    const res = await call("factory_submit_review", verdict("y".repeat(50_000)));
    expect(res.isError, res.text).toBe(false);
    expect(submitted[0]?.verdict).toBe("request_changes");
    expect(submitted[0]?.summary.length).toBeLessThanOrEqual(REVIEW_SUMMARY_MAX);
    expect(submitted[0]?.summary).toMatch(/… \(truncated\)$/);
    // The stored verdict is valid, and the reviewer learns it was cut (and not to resubmit).
    expect(ReviewVerdict.safeParse(submitted[0]).success).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      recorded: true,
      message:
        "Verdict recorded: request_changes. Your summary was 50,000 characters, so it was stored cut to 20,000; the full text stays in this session. Don't submit it again.",
    });
  });

  it("documents the summary limit in the tool description and its input schema", () => {
    expect(factorySubmitReview.description).toMatch(/20,000 characters/);
    const listed = describeTool(factorySubmitReview);
    const summary = (listed.inputSchema.properties as Record<string, Record<string, unknown>>)
      .summary;
    // No maxLength: a client must not reject a long summary before the server stores it.
    expect(summary).not.toHaveProperty("maxLength");
    expect(summary?.description).toMatch(/20,000 characters/);
  });
});

describe("rejected tool calls", () => {
  it("say what to fix and to call the tool again", async () => {
    const { call, submitted } = reviewTool();
    const { vision: _omit, ...missingVision } = verdict("Fine");
    const res = await call("factory_submit_review", missingVision);
    expect(res.isError).toBe(true);
    expect(res.text).toMatchInlineSnapshot(`
      "Invalid input for factory_submit_review, nothing was done:
      - vision: Invalid input: expected object, received undefined
      Fix the arguments and call \`factory_submit_review\` again."
    `);
    expect(submitted).toHaveLength(0);
  });

  it("give the length and the limit of a string that is too long", async () => {
    const noteTool = defineTool({
      name: "test_note",
      description: "A test tool",
      roles: ["agent"],
      scope: "session",
      input: z.object({ note: z.string().max(10) }),
      handler: async () => "ok",
    });
    const { call } = reviewTool([noteTool]);
    const res = await call("test_note", { note: "z".repeat(5_214) });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      [
        "Invalid input for test_note, nothing was done:",
        "- note is 5,214 characters; the limit is 10. Shorten it.",
        "Fix the arguments and call `test_note` again.",
      ].join("\n"),
    );
  });
});

describe("reviewer prompt", () => {
  const item = {
    id: "i1",
    type: "bug",
    title: "Crash on save",
    acceptanceCriteria: ["Saving an empty task works"],
    investigation: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
  } as never;

  it("asks for one verdict but lets the reviewer retry a rejected call", () => {
    const text = reviewerPrompt(item, "v", null, "main", false);
    expect(text).not.toMatch(/exactly once/);
    expect(text.split("\n").at(-1)).toMatchInlineSnapshot(
      `"Then submit one verdict with \`factory_submit_review\`: \`approve\` only when everything holds, \`request_changes\` for fixable problems (they go back to the author), \`reject\` when the change should not exist. Be specific in the summary (up to 20,000 characters are stored). If the call is rejected for invalid input, nothing was recorded: fix what the error names and call it again. Once a verdict is recorded, don't submit another."`,
    );
    expect(reReviewPrompt(item)).not.toMatch(/call `factory_submit_review` once/);
    expect(reReviewPrompt(item)).toMatch(/fix what the error names and call it again/);
  });
});
