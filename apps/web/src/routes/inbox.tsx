import { useQuery } from "@tanstack/react-query";
import { CheckCheck, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, SectionLabel } from "@/components/common/bits";
import { FOCUSED_ENTRY, InboxEntry, inboxEntryId } from "@/components/inbox/inbox-entry";
import { ConflictCard } from "@/components/project/conflict-card";
import { useClient } from "@/lib/api";
import { groupInbox, type InboxFilter, inboxCounts } from "@/lib/inbox";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "asks", label: "Needs an answer" },
  { id: "reviews", label: "Reviews" },
  { id: "problems", label: "Problems" },
];

/**
 * Inbox (§11.1): everything waiting on you, answerable in place. `focusItemId` (a toast's Open)
 * scrolls that item into view and highlights it.
 */
export function InboxPage({ focusItemId }: { focusItemId?: string }) {
  const client = useClient();
  const items = useSnapshotData((s) => s.inbox, []);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: () => client.listConflicts() });
  const conflictList = conflicts.data ?? [];
  const groups = groupInbox(items, filter);
  const counts = inboxCounts(items, conflictList.length);
  const resolved = items.filter((i) => i.status !== "open").slice(0, 5);
  const showConflicts = (filter === "all" || filter === "asks") && conflictList.length > 0;

  // A toast's Open: show every item, then scroll once the target has actually rendered, from
  // the snapshot or (a conflict, whose record id is its inbox item id) the conflicts query.
  useEffect(() => {
    if (focusItemId) setFilter("all");
  }, [focusItemId]);
  const focusRendered =
    focusItemId !== undefined &&
    [
      ...(showConflicts ? conflictList.map((c) => c.id) : []),
      ...groups.flatMap((g) => g.items.map((i) => i.id)),
      ...resolved.map((i) => i.id),
    ].includes(focusItemId);
  useEffect(() => {
    if (!focusItemId || !focusRendered) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(inboxEntryId(focusItemId))
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusItemId, focusRendered]);

  return (
    <>
      <PageHeader icon={<Inbox />} title="Inbox" meta={`${counts.all} waiting on you`} />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-6">
          <div className="mb-6 flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-card/50 p-0.5 text-xs">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground pointer-coarse:h-10",
                  filter === f.id && "bg-accent text-foreground",
                )}
              >
                {f.label}
                <span className="text-3xs tabular-nums opacity-70">{counts[f.id]}</span>
              </button>
            ))}
          </div>

          {groups.length === 0 && !showConflicts ? (
            <EmptyState icon={<CheckCheck />} title="You're all caught up" className="py-24">
              Questions, approvals, PRs ready for review and failed runs show up here.
            </EmptyState>
          ) : (
            <div className="space-y-9">
              {showConflicts && (
                <section>
                  <SectionLabel className="mb-3">Conflicts · {conflictList.length}</SectionLabel>
                  <div className="space-y-4">
                    {conflictList.map((c) => (
                      <div
                        key={c.id}
                        id={inboxEntryId(c.id)}
                        className={cn(c.id === focusItemId && FOCUSED_ENTRY)}
                        data-focused={c.id === focusItemId || undefined}
                      >
                        <ConflictCard conflict={c} />
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {groups.map((g) => (
                <section key={g.id}>
                  <SectionLabel className="mb-3">
                    {g.title} · {g.items.length}
                  </SectionLabel>
                  <div className="space-y-5">
                    {g.items.map((item) => (
                      <InboxEntry key={item.id} item={item} focused={item.id === focusItemId} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {resolved.length > 0 && (
            <section className="mt-12">
              <SectionLabel className="mb-3">Recently resolved</SectionLabel>
              <div className="space-y-3">
                {resolved.map((item) => (
                  <InboxEntry key={item.id} item={item} focused={item.id === focusItemId} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
