import type { FactoryStats } from "@codeden/contracts";
import type { FixtureWorkItem } from "./factory-fixture-types";
import { gh } from "./helpers";

const sf = gh("hearth-co/storefront");

/**
 * Work items behind the storefront's merge queue, plus escalated, failed and watching work, so
 * every stage of the Factory view has something to show in the mock UI.
 */
export const factoryViewInProgress: FixtureWorkItem[] = [
  {
    id: "fw-15",
    title: "Wishlist button on product cards",
    workKey: "issue:156",
    issue: sf.issue(156, "Wishlist"),
    pr: sf.pr(61, "Wishlist", "open"),
    sessionId: "s-a11y",
    stage: "verifying",
    type: "feature",
    step: "merge",
    stepMinutesAgo: 25,
  },
  {
    id: "fw-16",
    title: "Keyboard navigation in the cart drawer",
    workKey: "issue:148",
    issue: sf.issue(148, "Cart drawer keys"),
    pr: sf.pr(53, "Cart drawer keys", "open"),
    sessionId: "s-search",
    stage: "verifying",
    type: "feature",
    step: "merge",
    stepMinutesAgo: 70,
  },
  {
    id: "fw-17",
    title: "Saved addresses at checkout",
    workKey: "issue:141",
    issue: sf.issue(141, "Saved addresses"),
    pr: sf.pr(52, "Saved addresses", "open"),
    sessionId: "s-export",
    stage: "building",
    type: "feature",
    step: "implement",
    stepMinutesAgo: 48,
    note: "Rebuilding from the default branch after #52 kept conflicting",
  },
  {
    id: "fw-20",
    title: "Smaller product image thumbnails",
    workKey: "issue:145",
    issue: sf.issue(145, "Thumbnails"),
    pr: sf.pr(60, "Thumbnails", "merged"),
    stage: "watching",
    type: "feature",
    step: "merge",
    stepMinutesAgo: 6,
  },
];

export const factoryViewRecent: FixtureWorkItem[] = [
  {
    id: "fw-18",
    title: "Rotate the payment webhook secret",
    workKey: "issue:152",
    issue: sf.issue(152, "Webhook secret"),
    pr: sf.pr(50, "Webhook secret", "open"),
    stage: "escalated",
    type: "bug",
    step: "merge",
    stepMinutesAgo: 95,
    reason: "Touches a protected area (src/payments/webhook.ts): yours to merge",
  },
  {
    id: "fw-19",
    title: "Show delivery estimates on the cart page",
    workKey: "issue:143",
    issue: sf.issue(143, "Delivery estimates"),
    pr: sf.pr(51, "Delivery estimates", "closed"),
    stage: "failed",
    type: "feature",
    step: "stopped",
    stepMinutesAgo: 140,
    reason: "Review requested changes twice: the estimate ignores the warehouse cut-off time",
    failureKind: "checks",
  },
];

export const factoryViewStats: Partial<FactoryStats> = {
  failedToday: 1,
  revertedToday: 1,
  medianMergeMs7d: 3.4 * 60 * 60 * 1000,
  merged7d: 11,
};
