import {
  type InboxItem,
  type InboxItemKind,
  InboxSettlement,
  inboxWaitsOnYou,
} from "@codeden/contracts";

export type InboxFilter = "all" | "asks" | "reviews" | "problems";

export interface InboxGroup {
  id: InboxItemKind;
  title: string;
  items: InboxItem[];
}

const GROUPS: { id: InboxItemKind; title: string; filter: Exclude<InboxFilter, "all"> }[] = [
  { id: "approval", title: "Approvals", filter: "asks" },
  { id: "question", title: "Questions", filter: "asks" },
  { id: "spec_approval", title: "Specs to approve", filter: "asks" },
  { id: "setup_change", title: "Setup changes", filter: "asks" },
  { id: "pr_review", title: "Pull requests ready", filter: "reviews" },
  { id: "spot_check", title: "Spot-checks", filter: "reviews" },
  { id: "run_failed", title: "Failed runs", filter: "problems" },
  { id: "cleanup_failed", title: "Worktrees not removed", filter: "problems" },
  { id: "triage", title: "Triage decisions", filter: "asks" },
  { id: "automation_result", title: "Automation results", filter: "reviews" },
  { id: "message", title: "Messages", filter: "reviews" },
];

const priorityRank = { high: 0, normal: 1, low: 2 };

/** Open items grouped by kind (asks first), sorted by priority then newest. Empty groups dropped. */
export function groupInbox(items: InboxItem[], filter: InboxFilter = "all"): InboxGroup[] {
  const open = items.filter((i) => i.status === "open");
  return GROUPS.filter((g) => filter === "all" || g.filter === filter)
    .map((g) => ({
      id: g.id,
      title: g.title,
      items: open
        .filter((i) => i.kind === g.id)
        .sort(
          (a, b) =>
            priorityRank[a.priority] - priorityRank[b.priority] ||
            Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * A view's items split for the bulk dismiss (§11.1): the notices it dismisses, and the items that
 * wait on the user (`inboxWaitsOnYou`), which stay. The server applies the same rule.
 */
export function splitForDismiss(items: InboxItem[]): { dismiss: InboxItem[]; stay: InboxItem[] } {
  const dismiss: InboxItem[] = [];
  const stay: InboxItem[] = [];
  for (const item of items) {
    if (item.status !== "open") continue;
    (inboxWaitsOnYou(item) ? stay : dismiss).push(item);
  }
  return { dismiss, stay };
}

/** Count per filter tab. */
export function inboxCounts(items: InboxItem[], conflicts: number): Record<InboxFilter, number> {
  const count = (f: InboxFilter) => groupInbox(items, f).reduce((n, g) => n + g.items.length, 0);
  return {
    all: count("all") + conflicts,
    asks: count("asks") + conflicts,
    reviews: count("reviews"),
    problems: count("problems"),
  };
}

/** Why the item closed without the user ("PR #12 merged", "PM: issue fixed upstream"), if so. */
export function settledNote(item: InboxItem): string | null {
  const parsed = InboxSettlement.safeParse(item.resolution);
  if (!parsed.success) return null;
  return parsed.data.by === "pm" ? `PM: ${parsed.data.note}` : parsed.data.note;
}
