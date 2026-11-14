import { type InboxItem, InboxSettlement } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleDot, GitPullRequest } from "lucide-react";
import { ProjectTile } from "@/components/shell/sidebar/project-group";
import { ApprovalCard } from "@/components/thread/cards/approval-card";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { useProject, useTranscript } from "@/lib/queries";
import type { TranscriptState } from "@/lib/transcript/reducer";
import { cn } from "@/lib/utils";
import { FactoryInboxCard, factoryInboxKind } from "./factory-inbox";
import { InboxActions, PrReviewStatus } from "./inbox-actions";
import { TriageCard } from "./triage-card";

/** The plan a plan approval asks about: the latest plan before it in the same turn. */
function planBefore(transcript: TranscriptState, itemId: string): string | undefined {
  const entry = transcript.items[itemId];
  if (!entry) return undefined;
  const ids = transcript.threads[entry.threadId]?.itemIds ?? [];
  for (let i = ids.indexOf(itemId) - 1; i >= 0; i--) {
    const before = transcript.items[ids[i] ?? ""];
    if (!before || before.turnId !== entry.turnId) return undefined;
    if (before.item.kind === "plan") return before.item.text;
  }
  return undefined;
}

/** The mirrored approval or question, answered with the same card as the transcript. */
function MirroredRequest({ item }: { item: InboxItem }) {
  const { transcript } = useTranscript(item.sessionId ?? undefined);
  const mirrored = item.itemId ? transcript?.items[item.itemId]?.item : undefined;
  if (!item.sessionId) return null;
  if (!transcript) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (mirrored?.kind === "approval_request") {
    const plan =
      mirrored.action === "plan" && item.itemId ? planBefore(transcript, item.itemId) : undefined;
    return <ApprovalCard item={mirrored} sessionId={item.sessionId} compact plan={plan} />;
  }
  if (mirrored?.kind === "user_question")
    return <QuestionCard item={mirrored} sessionId={item.sessionId} />;
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <h3 className="text-[14px] font-medium">{item.title}</h3>
      {item.body && <p className="mt-1 text-[13px] text-muted-foreground">{item.body}</p>}
    </div>
  );
}

/** Why CodeDen settled the item by itself ("PR #12 merged"), when it did. */
function settledNote(item: InboxItem): string | null {
  const parsed = InboxSettlement.safeParse(item.resolution);
  return parsed.success ? parsed.data.note : null;
}

/** DOM id of an inbox entry (a conflict card too), for scrolling it into view. */
export function inboxEntryId(itemId: string): string {
  return `inbox-item-${itemId}`;
}

/** The ring around the entry a toast's Open went to. */
export const FOCUSED_ENTRY =
  "rounded-xl ring-2 ring-primary/50 ring-offset-4 ring-offset-background";

/**
 * One inbox item: context line, title, body, links, and the in-place answer (§11.1). `focused`
 * highlights the item a toast's Open went to.
 */
export function InboxEntry({ item, focused = false }: { item: InboxItem; focused?: boolean }) {
  const project = useProject(item.projectId);
  const resolved = item.status !== "open";
  const mirrors = item.kind === "approval" || item.kind === "question";
  return (
    <article
      id={inboxEntryId(item.id)}
      className={cn(resolved ? "opacity-60" : "animate-rise", focused && FOCUSED_ENTRY)}
      data-kind={item.kind}
      data-focused={focused || undefined}
    >
      <div className="mb-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
        {project && <ProjectTile project={project} />}
        <span>{project?.name ?? "Global"}</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{ago(item.createdAt)}</span>
        {item.priority === "high" && (
          <span className="rounded-full bg-status-failed/12 px-1.5 text-3xs font-medium text-status-failed">
            high
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {item.issue && (
            <button
              type="button"
              onClick={() => item.issue && platform.openExternal(item.issue.url)}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <CircleDot className="size-3 text-status-done" />#{item.issue.number}
            </button>
          )}
          {item.pr && (
            <button
              type="button"
              onClick={() => item.pr && platform.openExternal(item.pr.url)}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <GitPullRequest className="size-3 text-status-done" />#{item.pr.number}
            </button>
          )}
          {item.sessionId && (
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: item.sessionId }}
              className="flex items-center gap-0.5 hover:text-foreground"
            >
              Session <ArrowUpRight className="size-3" />
            </Link>
          )}
        </span>
      </div>
      {mirrors && !resolved ? (
        <MirroredRequest item={item} />
      ) : item.kind === "triage" ? (
        <TriageCard item={item} />
      ) : factoryInboxKind(item) ? (
        <FactoryInboxCard item={item} />
      ) : (
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <h3 className="text-[14px] font-medium">{item.title}</h3>
          {item.body && (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.body}</p>
          )}
          {item.kind === "pr_review" && !resolved && <PrReviewStatus item={item} />}
          {!resolved && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <InboxActions item={item} />
            </div>
          )}
          {resolved && (
            <p className="mt-2 text-2xs text-status-done">
              Resolved {item.resolvedAt ? ago(item.resolvedAt) : ""}
              {settledNote(item) && ` · ${settledNote(item)}`}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
