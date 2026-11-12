import {
  FactoryLimits,
  FactoryTuning,
  type ReviewVerdict,
  SetAutonomyModeRequest,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/services/factory/checks";
import type { FactoryPr } from "../src/services/factory/github-port";
import { matchesGlob } from "../src/services/factory/globs";
import {
  budgetExceeded,
  freeSlots,
  mayBuild,
  mayMerge,
  pickReviewer,
  protectedHits,
  queueOrder,
  shouldPause,
} from "../src/services/factory/policy";
import { parseVision, VISION_TEMPLATE } from "../src/services/factory/vision";

const limits = FactoryLimits.parse({
  maxConcurrentSessions: 2,
  maxMergesPerDay: 3,
  dailyBudget: { usd: 5, tokens: 1_000_000 },
  pauseAfterConsecutiveFailures: 2,
  protectedPaths: ["infra/**"],
});

const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

function pr(patch: Partial<FactoryPr> = {}): FactoryPr {
  return {
    ref: { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" },
    title: "Add a counter",
    body: "Fixes #3\n\n## Test results\n- `pnpm test`: 12 passed",
    headSha: "abc",
    headBranch: "codeden/counter",
    checks: "success",
    failedChecks: [],
    additions: 40,
    deletions: 3,
    files: ["src/counter.ts", "test/counter.test.ts"],
    ...patch,
  };
}

function checks(patch: Partial<Parameters<typeof evaluateChecks>[0]> = {}) {
  return evaluateChecks({
    pr: pr(),
    issueTitle: "Add a counter",
    review: approve,
    reviewer: "codex",
    type: "feature",
    evidence: null,
    testOutput: null,
    audit: null,
    auditConfigured: false,
    ciGraceOver: true,
    limits,
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: ["**/auth/**"], topics: ["payments"] },
    now: new Date().toISOString(),
    ...patch,
  });
}

describe("factory policy (§10.1)", () => {
  it("enforces the daily budget, slots, merge cap and pause threshold", () => {
    expect(budgetExceeded({ usd: 4.99, tokens: 10 }, limits)).toBeNull();
    expect(budgetExceeded({ usd: 5, tokens: 10 }, limits)).toMatch(/daily budget/);
    expect(budgetExceeded({ usd: 0, tokens: 1_000_000 }, limits)).toMatch(/token budget/);
    expect(freeSlots(1, limits)).toBe(1);
    expect(freeSlots(3, limits)).toBe(0);
    expect(mayBuild(2, 0, limits)).toBe(true);
    expect(mayBuild(2, 1, limits)).toBe(false);
    expect(mayMerge(2, limits)).toBe(true);
    expect(mayMerge(3, limits)).toBe(false);
    expect(shouldPause(1, limits)).toBe(false);
    expect(shouldPause(2, limits)).toBe(true);
  });

  it("queues repairs of main, then people's issues by age, then the scout's by priority", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 11, 14, min)).toISOString();
    const queued = [
      { id: "scout normal", source: "discovery", score: 0.6, createdAt: at(1) },
      { id: "person later", source: "issue", score: null, createdAt: at(5) },
      { id: "scout high", source: "discovery", score: 0.9, createdAt: at(2) },
      { id: "failed check", source: "failed_check", score: 0.9, createdAt: at(9) },
      { id: "person earlier", source: "issue", score: null, createdAt: at(0) },
    ] as const;
    expect([...queued].sort(queueOrder).map((i) => i.id)).toEqual([
      "failed check",
      "person earlier",
      "person later",
      "scout high",
      "scout normal",
    ]);
  });

  it("picks a reviewer on a different provider from the author, falling back with a note", () => {
    expect(pickReviewer("claude", ["claude", "codex"])).toEqual({
      provider: "codex",
      crossProvider: true,
      note: null,
    });
    expect(pickReviewer("codex", ["claude", "codex"]).provider).toBe("claude");
    const same = pickReviewer("claude", ["claude"]);
    expect(same.provider).toBe("claude");
    expect(same.crossProvider).toBe(false);
    expect(same.note).toMatch(/same provider/);
    expect(pickReviewer(null, ["claude", "codex"]).provider).toBe("codex");
  });

  it("matches protected globs and topics", () => {
    expect(matchesGlob("src/auth/login.ts", "**/auth/**")).toBe(true);
    expect(matchesGlob("auth/x.ts", "**/auth/**")).toBe(true);
    expect(matchesGlob("src/author.ts", "**/auth/**")).toBe(false);
    expect(matchesGlob("LICENSE", "LICENSE")).toBe(true);
    expect(matchesGlob("docs/LICENSE", "LICENSE")).toBe(true);
    expect(matchesGlob("infra/main.tf", "infra/**")).toBe(true);
    const hits = protectedHits({
      files: ["src/auth/login.ts", "infra/main.tf", "src/ok.ts", ".github/workflows/deploy.yml"],
      text: "Change payments flow",
      limits,
      areas: { globs: ["**/auth/**"], topics: ["payments", "licensing"] },
    });
    expect(hits.paths.map((h) => h.path)).toEqual([
      "src/auth/login.ts",
      "infra/main.tf",
      ".github/workflows/deploy.yml",
    ]);
    expect(hits.topics).toEqual(["payments"]);
    const deploysAllowed = protectedHits({
      files: [".github/workflows/deploy.yml"],
      text: "",
      limits: { ...limits, allowDeploys: true },
      areas: { globs: [], topics: [] },
    });
    expect(deploysAllowed.paths).toEqual([]);
  });

  it("parses the vision template into sections and protected areas", () => {
    const v = parseVision(VISION_TEMPLATE);
    expect(v.goals.length).toBeGreaterThan(0);
    expect(v.qualityBar).toContain("CI is green before merge");
    expect(v.protectedAreas.globs).toEqual(
      expect.arrayContaining(["**/auth/**", "**/migrations/**", ".github/workflows/**", "LICENSE"]),
    );
    expect(v.protectedAreas.topics).toEqual(["payments", "licensing"]);
    // Topics imply paths too.
    expect(v.protectedAreas.globs).toEqual(expect.arrayContaining(["**/billing/**"]));
    const custom = parseVision("## Protected areas\n- src/secrets/* — keys\n- Data migrations\n");
    expect(custom.protectedAreas.globs).toEqual(
      expect.arrayContaining(["src/secrets/*", "**/migrations/**"]),
    );
    expect(custom.protectedAreas.topics).toEqual(["data migrations"]);
  });

  it("requires limits for factory modes in the request shape and reads the old mode id", () => {
    expect(SetAutonomyModeRequest.parse({ mode: "dark_factory" }).limits).toBeUndefined();
    expect(SetAutonomyModeRequest.safeParse({ mode: "yolo" }).success).toBe(false);
    // "autopilot" was the software factory's id before 0.6.
    expect(SetAutonomyModeRequest.parse({ mode: "autopilot" }).mode).toBe("software_factory");
  });
});

describe("merge checks (§10.1 step 4)", () => {
  it("pass when CI, review, tests, security and size are green", () => {
    const r = checks();
    expect(r.outcome).toBe("pass");
    expect(Object.fromEntries(r.checks.map((c) => [c.name, c.state]))).toEqual({
      protected_paths: "pass",
      size: "pass",
      ci: "pass",
      review: "pass",
      tests: "pass",
      test_results: "pass",
      security: "pass",
      ui_evidence: "skipped",
    });
  });

  it("wait for the reviewer and for CI", () => {
    expect(checks({ review: null }).outcome).toBe("pending");
    expect(checks({ pr: pr({ checks: "pending" }) }).outcome).toBe("pending");
    expect(checks({ pr: pr({ checks: "none" }), ciGraceOver: false }).outcome).toBe("pending");
  });

  it("fail on red CI, missing CI, missing tests, a rejected review, size and missing screenshots", () => {
    const failed = (r: ReturnType<typeof checks>) =>
      r.checks.filter((c) => c.state === "fail").map((c) => c.name);
    expect(failed(checks({ pr: pr({ checks: "failure", failedChecks: ["test"] }) }))).toEqual([
      "ci",
    ]);
    expect(failed(checks({ pr: pr({ checks: "none" }) }))).toEqual(["ci"]);
    expect(failed(checks({ pr: pr({ files: ["src/counter.ts"] }) }))).toEqual(["tests"]);
    expect(
      failed(
        checks({
          review: { ...approve, verdict: "request_changes", summary: "Missing edge case" },
        }),
      ),
    ).toEqual(["review"]);
    expect(failed(checks({ pr: pr({ additions: 5_000 }) }))).toEqual(["size"]);
    const ui = checks({
      pr: pr({ files: ["src/Button.tsx", "test/button.test.ts"] }),
      evidence: false,
    });
    expect(failed(ui)).toEqual(["ui_evidence"]);
    expect(
      checks({ pr: pr({ files: ["src/Button.tsx", "test/button.test.ts"] }), evidence: true })
        .outcome,
    ).toBe("pass");
    expect(
      failed(
        checks({ review: { ...approve, security: { concerns: ["SQL injection in query()"] } } }),
      ),
    ).toEqual(["security"]);
    expect(
      failed(
        checks({ auditConfigured: true, audit: { ok: false, detail: "1 high vulnerability" } }),
      ),
    ).toEqual(["security"]);
  });

  it("escalate changes to protected areas instead of merging", () => {
    const r = checks({ pr: pr({ files: ["src/auth/session.ts", "test/a.test.ts"] }) });
    expect(r.outcome).toBe("escalate");
    expect(r.checks.find((c) => c.name === "protected_paths")).toMatchObject({
      state: "fail",
      escalate: true,
    });
    expect(checks({ pr: pr({ title: "Rework payments" }) }).outcome).toBe("escalate");
  });

  it("accept docs-only changes without tests", () => {
    expect(checks({ pr: pr({ files: ["README.md"] }) }).outcome).toBe("pass");
  });

  it("need test results for code changes: in the PR description or attached", () => {
    const bare = pr({ body: "Fixes #3" });
    const state = (r: ReturnType<typeof checks>) =>
      r.checks.find((c) => c.name === "test_results")?.state;
    expect(state(checks({ pr: bare, testOutput: null }))).toBe("pending");
    expect(state(checks({ pr: bare, testOutput: false }))).toBe("fail");
    expect(state(checks({ pr: bare, testOutput: true }))).toBe("pass");
    expect(state(checks({ pr: pr({ body: "Fixes #3", files: ["README.md"] }) }))).toBe("skipped");
  });

  it("skip the agent review for docs-only changes in the docs pipeline, never for code", () => {
    const docs = checks({ type: "docs", review: null, pr: pr({ files: ["docs/guide.md"] }) });
    expect(docs.outcome).toBe("pass");
    expect(docs.checks.find((c) => c.name === "review")?.state).toBe("skipped");
    // A "docs" item that changes code is reviewed like anything else.
    expect(checks({ type: "docs", review: null }).outcome).toBe("pending");
    // Other pipelines always wait for the reviewer.
    expect(
      checks({ type: "bug", review: null, pr: pr({ files: ["docs/guide.md"] }) }).outcome,
    ).toBe("pending");
  });
});
