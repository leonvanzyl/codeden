import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useClient } from "@/lib/api";
import type { Suggestion } from "./suggestion-menu";
import { detectTrigger, rankCommands, type Trigger } from "./trigger";

/** Suggestions for the active `@` or `/` trigger at the caret. */
export function useSuggestions(sessionId: string, text: string, caret: number) {
  const client = useClient();
  const trigger: Trigger | null = useMemo(() => detectTrigger(text, caret), [text, caret]);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const mentions = useQuery({
    queryKey: ["mentions", sessionId, trigger?.kind === "mention" ? trigger.query : null],
    queryFn: () => client.searchMentions(sessionId, trigger?.query ?? ""),
    enabled: trigger?.kind === "mention",
    staleTime: 30_000,
  });
  const commands = useQuery({
    queryKey: ["commands", sessionId],
    queryFn: () => client.listSlashCommands(sessionId),
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
  return {
    trigger,
    items,
    open,
    active,
    setActive,
    dismiss: () => setDismissedAt(trigger?.start ?? null),
    title: trigger?.kind === "mention" ? "Files" : "Commands & skills",
  };
}
