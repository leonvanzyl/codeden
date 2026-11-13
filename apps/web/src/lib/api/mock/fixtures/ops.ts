import { FactoryLimits, type FsListResponse, type SetupCheck } from "@codeden/contracts";
import type { FactoryFixture } from "./factory-fixture-types";
import {
  factoryViewInProgress,
  factoryViewPrs,
  factoryViewRecent,
  factoryViewStats,
} from "./factory-view";
import { gh } from "./helpers";

const sf = gh("hearth-co/storefront");

export function factoryFor(
  projectId: string,
  mode: FactoryFixture["mode"],
  limits: FactoryLimits,
): FactoryFixture {
  if (projectId !== "p-storefront") {
    return {
      projectId,
      mode,
      loopState: "idle",
      killSwitch: false,
      limits,
      spendToday: { tokens: 0, usd: 0 },
      mergesToday: 0,
      consecutiveFailures: 0,
      backlog: [],
      inProgress: [],
      mergeChecks: [],
      recent: [],
      ignored: [],
      visionExists: false,
    };
  }
  return {
    projectId,
    mode,
    loopState: "building",
    killSwitch: false,
    limits,
    spendToday: { tokens: 3_420_000, usd: 14.6 },
    mergesToday: 3,
    consecutiveFailures: 0,
    visionExists: true,
    backlog: [
      {
        id: "fw-1",
        title: "Dark mode for the storefront",
        workKey: "issue:151",
        issue: sf.issue(151, "Dark mode"),
        pr: null,
        stage: "backlog",
        type: "feature",
        step: "queued",
      },
      {
        id: "fw-2",
        title: "Lazy-load product images below the fold",
        workKey: "issue:153",
        issue: sf.issue(153, "Lazy-load images"),
        pr: null,
        stage: "backlog",
        type: "feature",
        step: "queued",
      },
      {
        id: "fw-3",
        title: "Cover discount-code edge cases with tests",
        workKey: "issue:154",
        issue: sf.issue(154, "Discount tests"),
        pr: null,
        stage: "backlog",
        type: "bug",
        step: "queued",
      },
      {
        id: "fw-4",
        title: "Replace moment with date-fns",
        workKey: "issue:149",
        issue: sf.issue(149, "Drop moment"),
        pr: null,
        stage: "candidate",
        step: "intake",
      },
    ],
    inProgress: [
      {
        id: "fw-5",
        title: "Product search with filters",
        workKey: "issue:139",
        issue: sf.issue(139, "Search"),
        pr: sf.pr(57, "Search", "draft"),
        sessionId: "s-search",
        stage: "building",
        type: "feature",
        step: "implement",
      },
      {
        id: "fw-6",
        title: "Fix flaky checkout e2e test",
        workKey: "issue:142",
        issue: sf.issue(142, "Flaky checkout"),
        pr: null,
        sessionId: "s-checkout",
        stage: "building",
        type: "bug",
        step: "reproduce",
      },
      {
        id: "fw-12",
        title: "Document the returns API",
        workKey: "issue:155",
        issue: sf.issue(155, "Returns API docs"),
        pr: null,
        sessionId: "s-export",
        stage: "building",
        type: "docs",
        step: "implement",
      },
      {
        id: "fw-13",
        title: "Coupon total rounds the wrong way",
        workKey: "issue:150",
        issue: sf.issue(150, "Coupon rounding"),
        pr: sf.pr(59, "Coupon rounding", "open"),
        sessionId: "s-deps",
        stage: "verifying",
        type: "bug",
        step: "review",
        attempts: 1,
        checks: { passed: 5, failed: 0, total: 8 },
      },
      {
        id: "fw-7",
        title: "Accessibility fixes on the product page",
        workKey: "pr:58",
        issue: null,
        pr: sf.pr(58, "A11y fixes", "open"),
        sessionId: "s-a11y",
        stage: "verifying",
        type: "feature",
        step: "merge",
      },
      ...factoryViewInProgress,
    ],
    stats: factoryViewStats,
    mergeChecks: [
      {
        prNumber: 58,
        title: "Accessibility fixes on the product page",
        checks: [
          { name: "ci", state: "pass" },
          { name: "tests", state: "pass" },
          { name: "test_results", state: "pass", detail: "Test results in the PR" },
          { name: "review", state: "pass", detail: "Codex review: approved" },
          { name: "security", state: "pass" },
          { name: "ui_evidence", state: "pass", detail: "2 screenshots" },
          { name: "size", state: "pass", detail: "+18 −9" },
        ],
      },
      {
        prNumber: 57,
        title: "Product search with filters",
        checks: [
          { name: "ci", state: "pending" },
          { name: "tests", state: "pass" },
          { name: "review", state: "pending" },
          { name: "security", state: "pass" },
          { name: "ui_evidence", state: "fail", detail: "No screenshot of the price slider" },
          { name: "size", state: "pass", detail: "+61 −3" },
        ],
      },
    ],
    recent: [
      {
        id: "fw-8",
        title: "Sticky add-to-cart bar on mobile",
        workKey: "issue:144",
        issue: sf.issue(144, "Sticky bar"),
        pr: sf.pr(55, "Sticky bar", "merged"),
        stage: "merged",
      },
      {
        id: "fw-9",
        title: "Cache product JSON at the edge",
        workKey: "issue:146",
        issue: sf.issue(146, "Edge cache"),
        pr: sf.pr(56, "Edge cache", "merged"),
        stage: "reverted",
      },
      {
        id: "fw-10",
        title: "Gift-wrap option at checkout",
        workKey: "idea:gift-wrap",
        issue: null,
        pr: null,
        stage: "rejected",
      },
      {
        id: "fw-11",
        title: "Fix footer link contrast",
        workKey: "issue:147",
        issue: sf.issue(147, "Footer"),
        pr: sf.pr(54, "Footer contrast", "merged"),
        stage: "merged",
      },
      ...factoryViewRecent,
    ],
    pullRequests: [
      {
        itemId: "fw-7",
        title: "Accessibility fixes on the product page",
        pr: sf.pr(58, "A11y fixes", "open"),
        state: "updating",
        queuePosition: 1,
        note: "Next to merge: updating it with main (1 commit behind), then CI runs on the new head",
      },
      {
        itemId: "fw-15",
        title: "Wishlist button on product cards",
        pr: sf.pr(61, "Wishlist", "open"),
        state: "queued",
        queuePosition: 2,
        note: "Every check passed; queued to merge (number 2 in line)",
      },
      {
        itemId: "fw-13",
        title: "Coupon total rounds the wrong way",
        pr: sf.pr(59, "Coupon rounding", "open"),
        state: "waiting_ci",
        queuePosition: null,
        note: "CI is running",
      },
      {
        itemId: "fw-16",
        title: "Keyboard navigation in the cart drawer",
        pr: sf.pr(53, "Cart drawer keys", "open"),
        state: "rebasing",
        queuePosition: null,
        note: "Merge conflicts with main: the author is rebasing (not a revise round)",
      },
      {
        itemId: "fw-17",
        title: "Saved addresses at checkout",
        pr: sf.pr(52, "Saved addresses", "open"),
        state: "rebuilding",
        queuePosition: null,
        note: "Rebuilding from the default branch: #52 still had merge conflicts with main after 3 requests to rebase",
      },
      {
        itemId: "fw-18",
        title: "Rotate the payment webhook secret",
        pr: sf.pr(50, "Webhook secret", "open"),
        state: "waiting_for_you",
        queuePosition: null,
        note: "Touches protected areas (paths: src/payments/webhook.ts)",
      },
      {
        itemId: "fw-8",
        title: "Sticky add-to-cart bar on mobile",
        pr: sf.pr(55, "Sticky bar", "merged"),
        state: "merged",
        queuePosition: null,
        note: "Merged; watching CI on the default branch",
      },
      ...factoryViewPrs,
    ],
    ignored: [
      {
        id: "fw-14",
        title: "Add a crypto checkout option",
        workKey: "issue:157",
        issue: sf.issue(157, "Crypto checkout"),
        pr: null,
        stage: "ignored",
        trust: "untrusted",
        author: "drive-by-dev",
      },
    ],
  };
}

export const defaultFactoryLimits = FactoryLimits.parse({});

const check = (
  c: Partial<SetupCheck> & Pick<SetupCheck, "id" | "label" | "message">,
): SetupCheck => ({
  state: "ok",
  installed: true,
  version: null,
  executablePath: null,
  loggedIn: null,
  authMethod: null,
  account: null,
  loginExpiresAt: null,
  fix: null,
  durationMs: 120,
  ...c,
});

export const setupChecks: SetupCheck[] = [
  check({
    id: "claude",
    label: "Claude Code",
    version: "2.1.4",
    loggedIn: true,
    authMethod: "claude.ai",
    message: "v2.1.4 · signed in (Max plan)",
  }),
  check({
    id: "codex",
    label: "Codex",
    state: "missing",
    version: "0.58.0",
    loggedIn: false,
    message: "Installed (0.58.0) but not signed in",
    fix: { kind: "login", command: "codex login" },
  }),
  check({
    id: "opencode",
    label: "OpenCode",
    version: "2.2.7",
    loggedIn: true,
    authMethod: "api key, oauth",
    account: "Anthropic, OpenAI",
    message: "Connected: Anthropic, OpenAI",
  }),
  check({
    id: "cursor",
    label: "Cursor",
    version: "2026.10.22-1a2b3c4",
    loggedIn: true,
    authMethod: "cursor",
    account: "leon@example.com",
    message: "Signed in",
  }),
  check({
    id: "gh",
    label: "GitHub CLI",
    loggedIn: true,
    account: "leon",
    message: "Signed in as leon · repo, workflow scopes",
  }),
  check({ id: "git", label: "git identity", message: "Leon van Zyl <leon@example.com>" }),
  check({ id: "browser", label: "Browser for agents", message: "Microsoft Edge 142" }),
];

type Tree = Record<string, { dirs: string[]; files?: string[]; repos?: string[] }>;

const tree: Tree = {
  "C:\\Users\\leon": { dirs: ["Code", "Documents", "Downloads", ".config"], files: [".gitconfig"] },
  "C:\\Users\\leon\\Code": {
    dirs: ["storefront", "billing-api", "notes-cli", "garden-planner", "dotfiles", "experiments"],
    repos: ["storefront", "billing-api", "notes-cli", "garden-planner", "dotfiles"],
  },
  "C:\\Users\\leon\\Code\\garden-planner": {
    dirs: ["src", "public", "tests"],
    files: ["package.json", "README.md", "vite.config.ts"],
  },
  "C:\\Users\\leon\\Code\\experiments": { dirs: ["wasm-audio", "rust-cli"], repos: ["wasm-audio"] },
  "C:\\Users\\leon\\Documents": { dirs: ["Notes", "Talks"] },
};

export function listDir(path: string | null, showHidden = false): FsListResponse {
  const p = path ?? "C:\\Users\\leon\\Code";
  const node = tree[p] ?? { dirs: [] };
  const parent =
    p.includes("\\") && p.split("\\").length > 2 ? p.slice(0, p.lastIndexOf("\\")) : null;
  return {
    path: p,
    parent,
    home: "C:\\Users\\leon",
    roots: [{ name: "C:", path: "C:\\" }],
    entries: node.dirs
      .filter((name) => showHidden || !name.startsWith("."))
      .map((name) => ({
        name,
        path: `${p}\\${name}`,
        isGitRepo: node.repos?.includes(name) ?? false,
        hidden: name.startsWith("."),
      })),
    truncated: false,
  };
}

export const visionDoc = `# Storefront vision

## Goals
- The calmest, fastest way to buy home goods online.
- Every page loads in under one second on a mid-range phone.

## Target users
Design-minded shoppers on mobile, often browsing in the evening.

## Principles
- Fewer, better features. No dark patterns.
- Accessibility is a feature: WCAG AA everywhere.

## Out of scope
- Marketplace / third-party sellers
- Loyalty points

## Quality bar
Tests for every behaviour change; screenshots for every UI change.

## Protected areas
- \`src/payments/**\`, \`migrations/**\`, \`infra/**\`
- Anything touching licensing or customer data exports
`;
