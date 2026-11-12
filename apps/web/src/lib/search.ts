import {
  type Session,
  TRANSCRIPT_SEARCH_MIN_TERM,
  type TranscriptSearchHit,
} from "@codeden/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useClient } from "./api";

/** True when the query has a term long enough to search transcripts with (3+ characters). */
export function canSearchTranscripts(q: string): boolean {
  return q
    .trim()
    .split(/\s+/)
    .some((t) => [...t].length >= TRANSCRIPT_SEARCH_MIN_TERM);
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (ms <= 0) {
      setSettled(value);
      return;
    }
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms <= 0 ? value : settled;
}

/**
 * Search transcripts as the user types (§13): waits `debounceMs` after the last keystroke,
 * keeps the previous hits on screen while the next search runs, and does nothing until the
 * query has a term of 3+ characters.
 */
export function useTranscriptSearch(
  q: string,
  opts: { limit?: number; projectId?: string; debounceMs?: number } = {},
) {
  const client = useClient();
  const settled = useDebouncedValue(q.trim(), opts.debounceMs ?? 200);
  const enabled = canSearchTranscripts(settled);
  const query = useQuery({
    queryKey: ["search", "transcripts", settled, opts.limit ?? null, opts.projectId ?? null],
    queryFn: () =>
      client.searchTranscripts({ q: settled, limit: opts.limit, projectId: opts.projectId }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  return {
    data: enabled ? query.data : undefined,
    error: query.error,
    /** Typing hasn't settled, or a search is running. */
    searching: canSearchTranscripts(q) && (q.trim() !== settled || query.isFetching),
  };
}

/** What kind of transcript entry matched, in a word. */
export function hitKindLabel(hit: Pick<TranscriptSearchHit, "kind" | "toolKind">): string {
  switch (hit.kind) {
    case "user_message":
      return "Prompt";
    case "assistant_message":
      return "Reply";
    case "plan":
      return "Plan";
    case "subagent":
      return "Subagent";
    case "user_question":
      return "Question";
    case "approval_request":
      return "Approval";
    case "notice":
      return "Notice";
    case "error":
      return "Error";
    case "tool_call":
      return TOOL_LABELS[hit.toolKind ?? "other"] ?? "Tool";
    default:
      return "Item";
  }
}

const TOOL_LABELS: Record<string, string> = {
  command: "Command",
  file_edit: "Edit",
  file_read: "Read",
  search: "Search",
  web: "Web",
  mcp: "Tool",
  browser: "Browser",
  other: "Tool",
};

/** "PM" and "Orchestrator" for role sessions; null for ordinary agent sessions. */
export function roleBadge(role: Session["role"]): string | null {
  if (role === "pm") return "PM";
  if (role === "orchestrator") return "Orchestrator";
  return null;
}
