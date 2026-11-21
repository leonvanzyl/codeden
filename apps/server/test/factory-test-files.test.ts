import { FactoryLimits, FactoryTuning, type ReviewVerdict } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/services/factory/checks";
import type { FactoryPr } from "../src/services/factory/github-port";
import { isDocFile, isTestFile, isUiFile } from "../src/services/factory/policy";

/**
 * Issue #571: the `tests` check said "Code changed but no test files were added or updated" on
 * pull requests that did change tests. The check reads every file of the PR's own diff, whatever
 * its status (added, modified, renamed, removed); what it missed were tests named by another
 * convention than `x.test.*` / `x.spec.*` in JS/TS, `x_test.go`, `x_test.py`, `test_x.py` or a
 * `test/`, `tests/`, `__tests__/`, `spec/` or `e2e/` folder.
 */

/** The reviewer found the tests adequate, and did not say none were needed. */
const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
  lessons: [],
};

function testsCheck(files: string[], renamedFrom?: string[]) {
  const pr: FactoryPr = {
    ref: { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" },
    title: "Fix the order total",
    body: "Fixes #3\n\n## Test results\n- 12 passed",
    headSha: "abc",
    headBranch: "codeden/order-total",
    checks: "success",
    failedChecks: [],
    mergeable: "mergeable",
    additions: 4,
    deletions: 1,
    files,
    ...(renamedFrom ? { renamedFrom } : {}),
  };
  const { checks } = evaluateChecks({
    pr,
    issueTitle: "Fix the order total",
    review: approve,
    approvedHead: "abc",
    reviewer: "codex",
    type: "bug",
    evidence: null,
    testOutput: null,
    audit: null,
    auditConfigured: false,
    ciTimedOut: true,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 5 } }),
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: [], topics: [] },
    now: "2026-11-20T10:00:00.000Z",
  });
  return checks.find((c) => c.name === "tests");
}

describe("the tests check counts every changed test file (#571)", () => {
  it.each([
    [
      "a .NET test project",
      "src/Orders/OrderService.cs",
      "tests/Orders.Tests/OrderServiceTests.cs",
    ],
    [
      "a .NET test project beside the code",
      "Orders/OrderService.cs",
      "Orders.UnitTests/UnitTest1.cs",
    ],
    ["a test class beside the code", "app/OrderService.java", "app/OrderServiceTest.java"],
    ["a Rust test file", "src/order.rs", "src/order_test.rs"],
    ["an RSpec file beside the code", "lib/order.rb", "lib/order_spec.rb"],
    ["a Pester test", "src/Get-Order.ps1", "src/Get-Order.Tests.ps1"],
    ["Django's tests.py", "orders/views.py", "orders/tests.py"],
    ["an integration test folder", "src/order.ts", "integration-tests/order.ts"],
    ["a Cypress spec", "src/order.ts", "src/order.cy.ts"],
  ])("code with %s passes", (_name, code, test) => {
    expect(testsCheck([code, test])).toMatchObject({
      state: "pass",
      detail: "1 test files changed",
    });
  });

  it("counts a test file the PR renamed, and one it only modified", () => {
    // GitHub lists a file by its path whatever its status; a rename also carries the old path.
    expect(testsCheck(["src/order.ts", "src/totals.test.ts"], ["src/order.test.ts"])).toMatchObject(
      { state: "pass", detail: "1 test files changed" },
    );
    expect(testsCheck(["src/order.ts", "src/order.test.ts"])?.state).toBe("pass");
  });

  it("needs no tests for a change of tests only", () => {
    expect(testsCheck(["tests/Orders.Tests/OrderServiceTests.cs"])).toMatchObject({
      state: "pass",
      detail: "No code changed",
    });
  });

  it("still fails code that comes without a test", () => {
    expect(testsCheck(["src/Orders/OrderService.cs", "README.md"])).toMatchObject({
      state: "fail",
      detail: "Code changed but no test files were added or updated",
    });
  });
});

describe("isTestFile", () => {
  it.each([
    "apps/server/test/factory-policy.test.ts",
    "src/__tests__/order.tsx",
    "src/__snapshots__/order.test.tsx.snap",
    "pkg/order/order_test.go",
    "tests/test_order.py",
    "orders/test_views.py",
    "orders/conftest.py",
    "src/order.spec.mts",
    "test/app.e2e-spec.ts",
    "lib/order_test.dart",
    "src/order_test.cc",
    "src/order-test.js",
    "scripts/test_install.sh",
    "Tests/OrdersTests/OrderTests.swift",
    "src/test/java/com/acme/OrderIT.java",
    "src/OrderSpec.scala",
    "unit_tests/order.py",
    "Acme.Orders.IntegrationTests/Fixture.cs",
  ])("%s is a test", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "src/order.ts",
    "src/Contest.cs",
    "src/Latest.java",
    "src/latest.ts",
    "src/attest.py",
    "src/contest.py",
    "src/latest.test.ts.snap",
    "src/TestOrder.java",
    "src/URLTest.java",
    "src/contest/entry.ts",
    "src/testing.ts",
    "src/ab-test/variant.ts",
    "releases/v1.latest/notes.ts",
    "src/OrderSpec.java",
    "docs/order.spec.md",
    "src/protest.go",
    "src/inspect.rb",
    "config/test.json",
  ])("%s is not a test", (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  // Names can't tell everything: code named like a test counts as one (see `test-files.ts`).
  it.each([
    "src/ab-test.ts",
    "scripts/load_test.sh",
    "src/api-spec.ts",
    "src/PodSpec.kt",
    "src/SpeedTest.cs",
    "locales/messages.cy.ts",
    "docs/spec/design.md",
  ])("%s is named like a test, so it counts as one (a known limit)", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it("keeps tests out of the UI and documentation rules", () => {
    expect(isUiFile("src/Order.test.tsx")).toBe(false);
    expect(isDocFile("docs/order.spec.md")).toBe(true);
    expect(isDocFile("tests/README.md")).toBe(false);
  });
});
