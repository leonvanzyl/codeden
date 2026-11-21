/**
 * Which changed files are tests, for the merge checks (`checks.ts`): the `tests` check wants one
 * next to changed code, and a test is never code, UI or documentation. Told from the path alone,
 * by the conventions of the common test runners, so a file counts whatever the pull request did
 * to it: added, modified, renamed (under its new path) or removed.
 *
 * Kept to names that are tests by convention: a file wrongly taken for a test would let code
 * through without one. A name can't tell everything, so code that is named like a test still
 * counts as one (`src/ab-test.ts`, `scripts/load_test.sh`, `src/api-spec.ts`, `PodSpec.kt`,
 * `SpeedTest.cs`, a Welsh `messages.cy.ts`, anything in a `test/` or `spec/` folder), and tests
 * named otherwise still count as code (`TestOrder.java`, `URLTest.java`, `OrderIT.java` outside
 * a test folder, `order_unittest.cc`, a bare `test.js`). The independent review and CI apply to
 * every file either way.
 */

/** Source files a test can be written in (not prose, data or config). */
const CODE =
  "(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|cs|fs|vb|php|swift|dart|exs?|scala|groovy|lua|ps1|sh|c|cc|cpp|cxx|m|mm)";

/** Kinds of test that name a folder or project: `integration-tests/`, `App.UnitTests/`. */
const KIND = "(?:unit|integration|functional|acceptance|e2e|ui)";

const PATTERNS: RegExp[] = [
  // Test folders at any depth: `test/`, `tests/`, `__tests__/`, `__snapshots__/`, `spec/`, `e2e/`,
  // `integration-tests/`, `unit_tests/`, and .NET test projects (`App.Tests/`, `App.UnitTests/`).
  new RegExp(
    `(^|/)(__tests__|__snapshots__|tests?|spec|e2e|${KIND}[-_]tests?|[^/]+\\.${KIND}?tests?)/`,
    "i",
  ),
  // `x.test.ts`, `x.spec.rb`, `x.e2e-spec.ts`, `x.cy.ts`, `X.Tests.ps1`.
  new RegExp(`\\.(tests?|spec|e2e|e2e-spec|cy)\\.${CODE}$`, "i"),
  // `x_test.go`, `x_test.rs`, `x_spec.rb`, `x-test.js`.
  new RegExp(`[_-](tests?|spec)\\.${CODE}$`, "i"),
  // `test_x.py`, `test_x.sh`.
  new RegExp(`(^|/)test_[^/]+\\.${CODE}$`, "i"),
  // Django's `tests.py` and pytest's `conftest.py`.
  /(^|\/)(tests|conftest)\.py$/i,
  // Class-per-file languages: `OrderServiceTest.java`, `OrderServiceTests.cs`. Case matters, so
  // `Contest.cs` and `Latest.java` are not tests.
  /[a-z0-9]Tests?\.(java|kts?|cs|fs|vb|swift|php|scala|groovy|dart)$/,
  // `OrderSpec.scala`, `OrderSpec.groovy`, `OrderSpec.kt`.
  /[a-z0-9]Spec\.(scala|groovy|kts?)$/,
];

/** Whether `path` (forward slashes, as GitHub lists it) is a test file. */
export function isTestFile(path: string): boolean {
  return PATTERNS.some((p) => p.test(path));
}
