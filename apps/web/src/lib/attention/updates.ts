import type { InboxItem, InboxNotify, Settings } from "@codeden/contracts";
import { isBlockingKind } from "./blocking";

/**
 * Toasts and desktop notifications for new inbox items that don't block an agent (§11.1).
 * Approvals and questions get the sticky attention toast instead (`attention.ts`).
 *
 * - The server tags every item with a category (`InboxItem.notify`); only the categories the
 *   user switched on in Settings → Notifications notify (factory activity is off by default).
 * - A burst becomes one toast: an update that arrives within `UPDATE_GROUP_WINDOW_MS` of the
 *   previous one joins its toast ("4 updates from the factory") instead of stacking a new one.
 * - Open goes to the thing itself: a failed run's session, otherwise the item in the inbox.
 */

/** How soon after the previous update a new one still joins its toast. */
export const UPDATE_GROUP_WINDOW_MS = 5_000;
/** How long an update toast stays; longer than the window, so a joining update finds it. */
export const UPDATE_TOAST_MS = 6_000;

const MAX_LINE = 120;

/** Whether a new item raises an update toast and notification: its category is switched on. */
export function notifiesFor(
  item: Pick<InboxItem, "kind" | "notify">,
  notifications: Settings["notifications"],
): boolean {
  if (isBlockingKind(item)) return false;
  return notifications.categories[item.notify];
}

/** Where an update's Open goes. */
export type UpdateTarget =
  | { to: "/sessions/$sessionId"; params: { sessionId: string } }
  | { to: "/inbox"; search: { item?: string } };

/** A failed run opens its session (the error and Retry are there); anything else, its inbox item. */
export function updateTarget(item: Pick<InboxItem, "id" | "kind" | "sessionId">): UpdateTarget {
  if (item.kind === "run_failed" && item.sessionId) {
    return { to: "/sessions/$sessionId", params: { sessionId: item.sessionId } };
  }
  return { to: "/inbox", search: { item: item.id } };
}

/**
 * The line under the title: the first sentence of the first body line that adds something,
 * without Markdown emphasis, at most `MAX_LINE` characters. A line repeating the title
 * ("Question: …" under "Factory decided: …") is skipped, so a decision shows what was decided.
 */
export function updateLine(item: Pick<InboxItem, "title" | "body">): string | undefined {
  if (!item.body) return undefined;
  const title = item.title.toLowerCase();
  for (const raw of item.body.split(/\r?\n/)) {
    const line = raw
      .replace(/\*\*|__|`/g, "")
      .replace(/^[\s#>-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    const gist = line
      .replace(/^[^:]{1,20}:\s*/, "")
      .slice(0, 30)
      .toLowerCase();
    if (gist.length >= 8 && title.includes(gist)) continue;
    // A full stop counts only before a space or the end, so "react@^19.2" stays whole.
    const sentence = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line;
    return sentence.length > MAX_LINE ? `${sentence.slice(0, MAX_LINE - 1)}…` : sentence;
  }
  return undefined;
}

const GROUP_TITLE: Record<InboxNotify, (n: number) => string> = {
  needs_you: (n) => `${n} things need you`,
  failure: (n) => `${n} failures need a look`,
  factory: (n) => `${n} updates from the factory`,
  automation: (n) => `${n} automation results`,
};

/** What an update toast (or notification) shows. */
export interface UpdateView {
  title: string;
  description: string | undefined;
  /** Failures show as errors. */
  tone: "default" | "error";
  action: "Open" | "Open inbox";
  target: UpdateTarget;
}

/** One item: its title and line, Open to the item. Several: a count, the latest, Open inbox. */
export function describeUpdates(items: readonly InboxItem[]): UpdateView {
  const latest = items[items.length - 1];
  if (!latest) throw new Error("describeUpdates needs at least one item");
  const failures = items.every((i) => i.notify === "failure");
  const tone = failures ? "error" : "default";
  if (items.length === 1) {
    return {
      title: latest.title,
      description: updateLine(latest),
      tone,
      action: "Open",
      target: updateTarget(latest),
    };
  }
  const categories = new Set(items.map((i) => i.notify));
  const only = categories.size === 1 ? latest.notify : null;
  return {
    title: only ? GROUP_TITLE[only](items.length) : `${items.length} new inbox items`,
    description: `Latest: ${latest.title}`,
    tone,
    action: "Open inbox",
    target: { to: "/inbox", search: {} },
  };
}

/** The toast an update goes to: `id` is shared by every update grouped into it. */
export interface UpdateBatch {
  id: string;
  items: InboxItem[];
}

export interface UpdateGrouper {
  /** Add a new update; returns its batch (the previous one when it arrived within the window). */
  add(item: InboxItem): UpdateBatch;
}

export function createUpdateGrouper(
  opts: { windowMs?: number; now?: () => number } = {},
): UpdateGrouper {
  const windowMs = opts.windowMs ?? UPDATE_GROUP_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let current: (UpdateBatch & { lastAt: number }) | null = null;
  return {
    add(item) {
      const at = now();
      current =
        current && at - current.lastAt <= windowMs
          ? { id: current.id, items: [...current.items, item], lastAt: at }
          : { id: `update:${item.id}`, items: [item], lastAt: at };
      return { id: current.id, items: current.items };
    },
  };
}
