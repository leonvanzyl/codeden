import type { Item } from "@codeden/contracts";
import { buildTranscript } from "./helpers";
import {
  assistant,
  cmd,
  edit,
  followups,
  notice,
  read,
  search,
  thought,
  todos,
  user,
} from "./item-builders";
import { cartPatch, countLines, specPatch } from "./patches";

const T = "t-checkout";
const R = "t-checkout-review";
const E = "t-checkout-explore";

const failingRun = `Running 20 tests using 4 workers

  ✓  checkout › guest can pay with card (2.1s)
  ✘  checkout › totals update after quantity change (5.3s)
  ✓  checkout › applies discount code (1.8s)
  ✘  checkout › totals update after quantity change (5.2s)
  ✓  checkout › shows order confirmation (3.0s)

  Error: expect(locator).toHaveText(expected)
    Expected: "$84.00"
    Received: "$42.00"

  4 failed, 16 passed (41.7s)`;

const passingRun = `Running 50 tests using 4 workers
  50 passed (1.6m)

To open last HTML report run:
  npx playwright show-report`;

const analysis = `Found it. The flake is a **race between two price requests**, not a slow page.

When the quantity input changes from \`1\` → \`2\`, the browser fires one \`/api/cart/price\` request per keystroke. If the *older* response lands last, \`useCart\` overwrites the newer total:

\`\`\`ts
const { total: next } = await res.json();
setTotal(next); // last response wins, even when it is stale
\`\`\`

The test hides this most of the time with a fixed \`waitForTimeout(500)\`, which is why it fails roughly 1 run in 5 on the slower CI runners.`;

const plan = `### Plan
1. **Guard stale responses** in \`useCart.updateQuantity\` with a monotonically increasing request id.
2. **Replace the sleep** in \`checkout.spec.ts\` with \`waitForResponse\` on the price endpoint.
3. Wait for \`networkidle\` before the confirmation step, which had the same smell.
4. Re-run the spec **50×** to prove the flake is gone.`;

const summary = `The checkout flake is fixed and verified.

| | Before | After |
|---|---|---|
| Runs | 20 | 50 |
| Failures | 4 (20%) | 0 |

**What changed**
- \`src/checkout/useCart.ts\`: ignore price responses that arrive after a newer request.
- \`tests/e2e/checkout.spec.ts\`: wait for the price response instead of sleeping 500 ms.

This was a real bug, not only a test problem: a customer typing quickly could see a stale total.`;

const review: Item[] = [
  thought("rv-1", "Checking the fix against the acceptance criteria in #142"),
  read("rv-2", "src/checkout/useCart.ts", 28, 56),
  read("rv-3", "tests/e2e/checkout.spec.ts"),
  search("rv-4", "setTotal(", 3, "src"),
  assistant(
    "rv-5",
    "The request-id guard is correct and minimal, and `useRef` is already imported in `useCart.ts`. No blocking issues so far; checking the discount path next…",
    true,
  ),
];

const explore: Item[] = [
  search("ex-1", "/api/cart/price", 4, "src"),
  read("ex-2", "src/checkout/useCart.ts", 1, 64),
  assistant(
    "ex-3",
    "`useCart.updateQuantity` fetches `/api/cart/price` on every change and calls `setTotal` with whichever response lands last.",
  ),
];

export const checkoutTranscript = buildTranscript(
  "s-checkout",
  [
    { id: T, title: "Fix flaky checkout e2e test" },
    {
      id: E,
      parentThreadId: T,
      parentItemId: "ck-explore",
      agentType: "Explore",
      title: "Find where the cart total is set",
    },
    {
      id: R,
      parentThreadId: T,
      parentItemId: "ck-sub",
      agentType: "code-reviewer",
      title: "Review the checkout fix",
    },
  ],
  [
    {
      id: "ck-turn-1",
      threadId: T,
      start: 34,
      end: 6,
      items: [
        user(
          "ck-u1",
          "Issue #142: the checkout e2e test fails about 1 in 5 runs on CI. Find the root cause and fix it properly — no retries. Screenshot of the last failure attached.",
          [
            {
              type: "image",
              mediaType: "image/png",
              name: "ci-failure.png",
              source: { type: "artifact", artifactId: "art-ci-shot" },
            },
          ],
        ),
        thought(
          "ck-r1",
          "Reading the failing spec and the cart hook",
          "The screenshot shows the total stuck at the single-item price. That points to state, not rendering. I'll read the spec, then find where the total is set.",
        ),
        read("ck-t1", "tests/e2e/checkout.spec.ts"),
        search("ck-t2", "waitForTimeout", 7, "tests"),
        {
          id: "ck-explore",
          kind: "subagent",
          status: "completed",
          childThreadId: E,
          agentType: "Explore",
          description: "Find where the cart total is set",
          summary:
            "useCart.updateQuantity sets the total from whichever price response lands last.",
          stats: { totalTokens: 48_213, toolUses: 23, durationMs: 72_000 },
        },
        read("ck-t3", "src/checkout/useCart.ts", 1, 64),
        cmd("ck-t4", "pnpm test:e2e checkout --repeat-each=20", failingRun, 1, 41_700),
        assistant("ck-a1", analysis),
        { id: "ck-plan", kind: "plan", status: "completed", text: plan },
        todos("ck-todo", [
          ["Guard stale price responses in useCart", "completed"],
          ["Replace the fixed sleep with waitForResponse", "completed"],
          ["Wait for networkidle before confirmation", "completed"],
          ["Re-run the spec 50 times", "completed"],
        ]),
        edit("ck-t5", [
          {
            path: "src/checkout/useCart.ts",
            change: "modify",
            diff: cartPatch,
            ...countLines(cartPatch),
          },
          {
            path: "tests/e2e/checkout.spec.ts",
            change: "modify",
            diff: specPatch,
            ...countLines(specPatch),
          },
        ]),
        cmd(
          "ck-t6",
          "pnpm typecheck && pnpm lint",
          "✓ typecheck (4 packages)\n✓ biome: no issues",
          0,
          8_900,
        ),
        cmd("ck-t7", "pnpm test:e2e checkout --repeat-each=50", passingRun, 0, 96_000),
        notice("ck-n1", "Turn checkpoint saved · 2 files changed", "info", "checkpoint"),
        assistant("ck-a2", summary),
        followups("ck-f1", [
          [
            "Open the PR",
            "Push the branch and open a PR that fixes #142, with the 50-run result as evidence.",
          ],
          [
            "Add a unit test",
            "Add a unit test for useCart that reproduces the out-of-order responses.",
          ],
          [
            "Check other sleeps",
            "Find other waitForTimeout calls in the e2e suite and replace them the same way.",
          ],
        ]),
      ],
    },
    {
      id: "ck-turn-2",
      threadId: T,
      start: 5,
      status: "running",
      items: [
        user(
          "ck-u2",
          "Ship it. Have the reviewer check it first, then squash the fixups, push and open the PR.",
        ),
        {
          id: "ck-sub",
          kind: "subagent",
          status: "in_progress",
          childThreadId: R,
          agentType: "code-reviewer",
          description: "Review the checkout fix against #142",
          prompt:
            "Review the diff on codeden/fix-checkout-flake against the acceptance criteria in #142.",
        },
        cmd(
          "ck-t8",
          "git rebase --autosquash main",
          "Successfully rebased and updated refs/heads/codeden/fix-checkout-flake.",
          0,
          900,
        ),
        {
          id: "ck-t9",
          kind: "tool_call",
          toolKind: "command",
          status: "in_progress",
          toolName: "Bash",
          command: "git push --force-with-lease origin codeden/fix-checkout-flake",
        },
        {
          id: "ck-approval",
          kind: "approval_request",
          status: "in_progress",
          requestId: "req-push",
          action: "git_destructive",
          title: "Force push to codeden/fix-checkout-flake",
          reason:
            "Rewrites history on a remote branch. The branch has no other authors, and --force-with-lease protects against overwriting new commits.",
          command: "git push --force-with-lease origin codeden/fix-checkout-flake",
          cwd: "~/.codeden/wt/storefront/fix-checkout-flake",
          toolCallItemId: "ck-t9",
          options: ["allow_once", "allow_session", "deny"],
        },
      ],
    },
    { id: "ex-turn-1", threadId: E, start: 33, end: 32, items: explore },
    { id: "rv-turn-1", threadId: R, start: 4, status: "running", items: review },
  ],
);
