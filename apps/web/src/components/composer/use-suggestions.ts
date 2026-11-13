import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useClient } from "@/lib/api";
import type { Suggestion } from "./suggestion-menu";
import { detectTrigger, rankCommands, type Trigger } from "./trigger";

/**
 * Where `@` and `/` suggestions come from: a session (its worktree, its provider's commands),
 * or a project and the provider a New session draft would start with (none when no provider is
 * ready: no `/` entries).
 */
export type SuggestionSource =
  | { kind: "session"; sessionId: string }
  | { kind: "project"; projectId: string; provider: string | null };

/** Suggestions for the active `@` or `/` trigger at the caret. */
export function useSuggestions(source: SuggestionSource, text: string, caret: number) {
  const client = useClient();
  const trigger: Trigger | null = useMemo(() => detectTrigger(text, caret), [text, caret]);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const sourceKey =
    source.kind === "session" ? [source.sessionId] : ["project", source.projectId, source.provider];

  const mentions = useQuery({
    queryKey: ["mentions", ...sourceKey, trigger?.kind === "mention" ? trigger.query : null],
    queryFn: () => {
      const query = trigger?.query ?? "";
      return source.kind === "session"
        ? client.searchMentions(source.sessionId, query)
        : client.searchProjectMentions(source.projectId, query);
    },
    enabled: trigger?.kind === "mention",
    staleTime: 30_000,
  });
  const commands = useQuery({
    queryKey: ["commands", ...sourceKey],
    queryFn: () =>
      source.kind === "session"
        ? client.listSlashCommands(source.sessionId)
        : source.provider
          ? client.listProjectSlashCommands(source.projectId, source.provider)
          : Promise.resolve([]),
    enabled: trigger?.kind === "command",
    staleTime: 60_000,
  });

  const items: Suggestion[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "mention") {
      return (mentions.data ?? []).map((m) => ({
        id: m.path,
        label: m.path,
        icon: m.kind,
        insert: `@${m.path}`,
      }));
    }
    return rankCommands(commands.data ?? [], trigger.query).map((c) => ({
      id: c.name,
      label: `/${c.name}`,
      description: c.description,
      icon: c.kind === "skill" ? ("skill" as const) : ("command" as const),
      insert: `/${c.name}`,
    }));
  }, [trigger, mentions.data, commands.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the query changes.
  useEffect(() => setActive(0), [trigger?.kind, trigger?.query]);

  const open = Boolean(trigger) && dismissedAt !== trigger?.start;
  const query = trigger?.kind === "mention" ? mentions : commands;
  return {
    trigger,
    items,
    open,
    /** The active trigger's results have not arrived yet. */
    loading: Boolean(trigger) && query.isPending,
    active,
    setActive,
    dismiss: () => setDismissedAt(trigger?.start ?? null),
    title: trigger?.kind === "mention" ? "Files" : "Commands & skills",
  };
}
