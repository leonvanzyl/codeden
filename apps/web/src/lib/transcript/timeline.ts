import type { FollowupSuggestion, Item, ItemOf, ToolCallItem, ToolKind } from "@codeden/contracts";
import type { ItemEntry, TranscriptState, TurnState } from "./reducer";
import { threadItems } from "./reducer";

/** One work entry inside a work group: a tool call or a reasoning block. */
export type WorkEntry = ToolCallItem | ItemOf<"reasoning">;

/** A row in the rendered transcript. Pure data so it can be virtualised and tested. */
export type TimelineRow =
  | { key: string; type: "user"; item: ItemOf<"user_message"> }
  | { key: string; type: "assistant"; item: ItemOf<"assistant_message">; streaming: boolean }
  | { key: string; type: "work"; turnId: string; entries: WorkEntry[]; live: boolean }
  | { key: string; type: "card"; item: Item }
  | {
      key: string;
      type: "turn-end";
      turn: TurnState;
      filesChanged: number;
      durationMs: number | null;
      /** The thread's latest turn (forking from it copies the whole conversation, §9). */
      latest: boolean;
    }
  | { key: string; type: "working"; turn: TurnState };

const CARD_KINDS = new Set<Item["kind"]>([
  "plan",
  "todo_list",
  "approval_request",
  "user_question",
  "subagent",
  "notice",
  "error",
]);

function isWork(item: Item): item is WorkEntry {
  return item.kind === "tool_call" || item.kind === "reasoning";
}

/**
 * Turn an ordered list of items into display rows:
 * - consecutive tool calls and reasoning in the same turn collapse into one work group;
 * - plans, todos, approvals, questions, subagents, notices and errors become cards;
 * - follow-ups are not rows (they render as chips above the composer);
 * - a finished turn gets a slim footer, the running turn a "working" row.
 */
export function buildTimeline(state: TranscriptState, threadId: string): TimelineRow[] {
  const entries = threadItems(state, threadId);
  const rows: TimelineRow[] = [];
  let group: { turnId: string; entries: WorkEntry[]; firstId: string } | null = null;
  const filesByTurn = new Map<string, Set<string>>();

  const flush = () => {
    if (!group) return;
    const live = group.entries.some((e) => e.status === "in_progress");
    rows.push({
      key: `work:${group.firstId}`,
      type: "work",
      turnId: group.turnId,
      entries: group.entries,
      live,
    });
    group = null;
  };

  const lastTurnRows = (turnId: string | null) => {
    if (!turnId) return;
    const turn = state.turns[turnId];
    if (!turn) return;
    if (turn.status === "running") {
      rows.push({ key: `working:${turnId}`, type: "working", turn });
      return;
    }
    const duration =
      turn.completedAt && turn.startedAt
        ? Date.parse(turn.completedAt) - Date.parse(turn.startedAt)
        : null;
    rows.push({
      key: `end:${turnId}`,
      type: "turn-end",
      turn,
      filesChanged: filesByTurn.get(turnId)?.size ?? 0,
      durationMs: duration,
      latest: state.threads[threadId]?.turnIds.at(-1) === turnId,
    });
  };

  let currentTurn: string | null = null;
  for (const entry of entries) {
    const { item, turnId } = entry;
    // Follow-ups are no rows, and the server's own suggestions for a turn can arrive after the
    // next turn began, so they must not split that turn in two.
    if (item.kind === "followups") continue;
    if (currentTurn !== null && turnId !== currentTurn) {
      flush();
      lastTurnRows(currentTurn);
    }
    currentTurn = turnId;
    if (item.kind === "tool_call" && item.toolKind === "file_edit") {
      const set = filesByTurn.get(turnId) ?? new Set<string>();
      for (const c of item.changes) set.add(c.path);
      filesByTurn.set(turnId, set);
    }
    if (isWork(item)) {
      if (group && group.turnId === turnId) group.entries.push(item);
      else {
        flush();
        group = { turnId, entries: [item], firstId: item.id };
      }
      continue;
    }
    flush();
    if (item.kind === "user_message") rows.push({ key: item.id, type: "user", item });
    else if (item.kind === "assistant_message")
      rows.push({
        key: item.id,
        type: "assistant",
        item,
        streaming: item.status === "in_progress",
      });
    else if (CARD_KINDS.has(item.kind)) rows.push({ key: item.id, type: "card", item });
  }
  flush();
  lastTurnRows(currentTurn);
  return rows;
}

/** Index of the row showing `itemId` (a work group shows several items), or -1. */
export function rowIndexOfItem(rows: TimelineRow[], itemId: string): number {
  return rows.findIndex((row) => {
    switch (row.type) {
      case "user":
      case "assistant":
      case "card":
        return row.item.id === itemId;
      case "work":
        return row.entries.some((e) => e.id === itemId);
      default:
        return false;
    }
  });
}

/** Follow-up suggestions of the latest completed turn, if it's the last turn (§7.5). */
export function latestFollowups(
  state: TranscriptState,
  threadId: string,
): FollowupSuggestion[] | null {
  const thread = state.threads[threadId];
  const lastTurnId = thread?.turnIds.at(-1);
  if (!lastTurnId || state.turns[lastTurnId]?.status !== "completed") return null;
  const items: ItemEntry[] = threadItems(state, threadId).filter((e) => e.turnId === lastTurnId);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]?.item;
    if (item?.kind === "followups") return item.suggestions;
  }
  return null;
}

/** Final assistant message of a turn (for read-aloud). */
export function finalAssistantText(state: TranscriptState, turnId: string): string | null {
  const turn = state.turns[turnId];
  if (!turn) return null;
  const items = threadItems(state, turn.threadId).filter((e) => e.turnId === turnId);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]?.item;
    if (item?.kind === "assistant_message") return item.text;
  }
  return null;
}

const KIND_VERBS: Record<ToolKind, [string, string, string]> = {
  command: ["Ran", "command", "commands"],
  file_edit: ["Edited", "file", "files"],
  file_read: ["Read", "file", "files"],
  search: ["Searched", "time", "times"],
  web: ["Fetched", "page", "pages"],
  mcp: ["Called", "tool", "tools"],
  browser: ["Used the browser", "time", "times"],
  other: ["Ran", "action", "actions"],
};

const KIND_PRIORITY: ToolKind[] = [
  "file_edit",
  "command",
  "browser",
  "mcp",
  "search",
  "file_read",
  "web",
  "other",
];

/** One-sentence summary of a work group, e.g. "Edited 2 files, ran 3 commands and 2 more". */
export function summarizeWork(entries: WorkEntry[]): string {
  const counts = new Map<ToolKind, number>();
  let thoughts = 0;
  for (const e of entries) {
    if (e.kind === "reasoning") thoughts++;
    else if (e.toolKind === "file_edit") {
      counts.set("file_edit", (counts.get("file_edit") ?? 0) + Math.max(1, e.changes.length));
    } else counts.set(e.toolKind, (counts.get(e.toolKind) ?? 0) + 1);
  }
  if (counts.size === 0) return thoughts > 1 ? `Thought ${thoughts} times` : "Thought";
  const kinds = KIND_PRIORITY.filter((k) => counts.has(k));
  const parts = kinds.slice(0, 2).map((k, i) => {
    const n = counts.get(k) ?? 0;
    const [verb, one, many] = KIND_VERBS[k];
    const v = i === 0 ? verb : verb.toLowerCase();
    return k === "browser"
      ? `${v} ${n > 1 ? `${n} ${many}` : ""}`.trim()
      : `${v} ${n} ${n === 1 ? one : many}`;
  });
  const rest = kinds.slice(2).reduce((sum, k) => sum + (counts.get(k) ?? 0), 0);
  if (rest > 0) return `${parts.join(", ")} and ${rest} more`;
  return parts.join(" and ").replace(/^(\w)/, (m) => m.toUpperCase());
}
