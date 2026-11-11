import { buildTranscript } from "./helpers";
import {
  assistant,
  browser,
  cmd,
  edit,
  followups,
  mcp,
  read,
  search,
  thought,
  user,
} from "./item-builders";
import { countLines, indexPatch, searchPatch } from "./patches";

export const orchestratorTranscript = buildTranscript(
  "s-orchestrator",
  [{ id: "t-orchestrator", title: "Orchestrator" }],
  [
    {
      id: "or-turn-1",
      threadId: "t-orchestrator",
      start: 12,
      end: 11,
      items: [
        user("or-u1", "Morning! What's going on across my projects?"),
        mcp(
          "or-t1",
          "codeden",
          "get_overview",
          "Get overview",
          "3 projects · 4 running · 6 in inbox",
        ),
        mcp("or-t2", "codeden", "list_inbox", "List inbox", "6 open items"),
        assistant(
          "or-a1",
          `Here's where things stand:

**Storefront** · dark factory
- 🔧 *Fix flaky checkout test* (#142) is done and **waiting on you** to approve a force push.
- 🔎 *Product search with filters* (#139) is building; draft PR #57 is open.
- 🛡️ The weekly *security audit* is running (3 of 7 areas).
- ❌ *Dependency updates* failed on a peer conflict — I'd retry after pinning React.

**Billing API** · assisted
- The webhook-retry agent asked **how failed webhooks should be retried**.

**notes-cli** · manual
- Quiet. Markdown export shipped yesterday.

Next scheduled: dependency updates in about 40 minutes.`,
        ),
        followups("or-f1", [
          ["Answer the webhook question", "Show me the webhook retry question and the options."],
          [
            "Retry dependency updates",
            "Retry the Storefront dependency updates with React pinned to 19.2.",
          ],
          ["Plan next week", "Draft a plan for next week across all projects."],
        ]),
      ],
    },
  ],
);

const streamingOutput = `> storefront@2.4.0 test /search
> vitest run src/search

 ✓ src/search/index.test.ts (9 tests) 41ms
 ✓ src/search/SearchFilters.test.tsx (6 tests) 188ms
`;

export const searchTranscript = buildTranscript(
  "s-search",
  [{ id: "t-search", title: "Add product search with filters" }],
  [
    {
      id: "se-turn-1",
      threadId: "t-search",
      start: 52,
      status: "running",
      items: [
        user(
          "se-u1",
          "Implement #139: product search with category chips and a max-price slider. Keep the URL as the source of truth so filters are shareable.",
        ),
        thought("se-r1", "Mapping the existing search module and routes"),
        read("se-t1", "src/search/index.ts"),
        read("se-t2", "src/routes/products.tsx"),
        search("se-t3", "useSearchParams", 4, "src"),
        edit("se-t4", [
          {
            path: "src/search/index.ts",
            change: "modify",
            diff: indexPatch,
            ...countLines(indexPatch),
          },
          {
            path: "src/search/SearchFilters.tsx",
            change: "add",
            diff: searchPatch,
            ...countLines(searchPatch),
          },
        ]),
        browser(
          "se-t5",
          "screenshot",
          "http://localhost:5173/products?category=Textiles",
          "Screenshot the products page",
        ),
        assistant(
          "se-a1",
          "Filters render and update the URL. Now running the search tests, then I'll wire the price slider.",
        ),
        cmd("se-t6", "pnpm vitest run src/search", streamingOutput, null),
      ],
    },
  ],
);

export const a11yTranscript = buildTranscript(
  "s-a11y",
  [{ id: "t-a11y", title: "UI review: product page accessibility" }],
  [
    {
      id: "ay-turn-1",
      threadId: "t-a11y",
      start: 130,
      end: 96,
      items: [
        user(
          "ay-u1",
          "Automation · UI review for PR #58. Check the product page against WCAG AA, fix what you can, and attach before/after evidence.",
        ),
        browser(
          "ay-t1",
          "navigate",
          "http://localhost:5173/products/linen-throw",
          "Open the product page",
        ),
        mcp(
          "ay-t2",
          "codeden",
          "browser_snapshot",
          "Accessibility snapshot",
          "14 images without alt text · 3 contrast failures",
        ),
        read("ay-t3", "src/theme/tokens.css"),
        edit("ay-t4", [
          { path: "src/theme/tokens.css", change: "modify", additions: 6, deletions: 6 },
          { path: "src/components/ProductCard.tsx", change: "modify", additions: 9, deletions: 2 },
          { path: "src/components/Button.tsx", change: "modify", additions: 3, deletions: 1 },
        ]),
        mcp(
          "ay-t5",
          "codeden",
          "generate_image",
          "Generate before/after comparison",
          JSON.stringify({ artifactIds: ["art-contrast"], paths: ["evidence/contrast.png"] }),
          { prompt: "Before/after contrast comparison of the product card", size: "1440x600" },
        ),
        mcp(
          "ay-t6",
          "codeden",
          "generate_image",
          "Generate release-notes illustration",
          JSON.stringify({ artifactIds: ["art-hero"], paths: ["docs/img/a11y-hero.png"] }),
          { prompt: "Warm, minimal illustration of a cozy den at dusk", size: "1536x864" },
        ),
        cmd(
          "ay-t7",
          "pnpm test && pnpm exec playwright test a11y",
          "✓ 212 unit tests\n✓ 8 a11y checks (axe) — 0 violations",
          0,
          52_000,
        ),
        assistant(
          "ay-a1",
          `All AA issues on the product page are fixed and **PR #58** is ready for review.

- **Contrast**: price and button text now meet 7.1:1 (was 2.9:1).
- **Alt text**: added to all 14 product images, generated from product names.
- **Focus**: restored visible focus rings on buttons and links.

Evidence (before/after) is attached to the PR.`,
        ),
        followups("ay-f1", [
          ["Review the PR", "Summarise the PR #58 diff for me file by file."],
          ["Audit the cart page", "Run the same accessibility review on the cart page."],
          [
            "Add axe to CI",
            "Add the axe accessibility checks to the CI workflow so regressions fail the build.",
          ],
        ]),
      ],
    },
  ],
);
