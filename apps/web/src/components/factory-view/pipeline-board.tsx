import type { FactoryStatus } from "@codeden/contracts";
import { ChevronDown, ChevronRight, UserRound } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { InfoHint } from "@/components/common/info-hint";
import { openPrOf, RetryButton } from "@/components/factory/retry-button";
import { cn } from "@/lib/utils";
import { useWide } from "./hooks";
import { ScoutCard } from "./scout-card";
import {
  describeMoves,
  NEEDS_YOU_LABEL,
  placesOf,
  VIEW_STAGES,
  type ViewCard,
  type ViewPipeline,
  type ViewPlace,
  type ViewStageId,
} from "./stages";
import { ViewCardButton } from "./view-card";

/**
 * Announces card moves politely ("#142 moved to Reviewing.") as the status changes; nothing on
 * the first render, so opening the view doesn't read every card out.
 */
function useMoveAnnouncement(pipeline: ViewPipeline): string {
  const before = useRef<Map<string, ViewPlace> | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const prev = before.current;
    before.current = placesOf(pipeline);
    if (!prev) return;
    const lines = describeMoves(prev, pipeline);
    if (lines.length === 0) return;
    setMessage(
      lines.length > 4
        ? `${lines.slice(0, 4).join(" ")} And ${lines.length - 4} more.`
        : lines.join(" "),
    );
  }, [pipeline]);
  return message;
}

function Cards({
  cards,
  now,
  onOpen,
  empty,
}: {
  cards: ViewCard[];
  now: number;
  onOpen: (card: ViewCard) => void;
  empty?: string;
}) {
  if (cards.length === 0)
    return empty ? <p className="px-1 py-2 text-2xs text-muted-foreground/70">{empty}</p> : null;
  return (
    <ul className="flex flex-col gap-1.5">
      {cards.map((c) => (
        <li key={c.item.id}>
          <ViewCardButton card={c} now={now} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/** One stage: a labelled region, a column on wide screens and a collapsible section below. */
function Stage({
  label,
  hint,
  count,
  wide,
  last,
  children,
}: {
  label: string;
  hint: string;
  count: number;
  wide: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(count > 0);
  const heading = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span id={headingId} className="text-[12px] leading-tight font-medium">
        {label}
      </span>
      <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums">
        {count}
      </span>
    </span>
  );
  if (wide)
    return (
      <section
        aria-labelledby={headingId}
        className="relative flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-surface/60"
        data-testid="factory-view-stage"
        data-stage={label}
      >
        {/* The flow, left to right: an arrow in the gap to the next stage. */}
        {!last && (
          <ChevronRight
            className="absolute top-2.5 -right-[11px] z-10 size-3.5 rounded-full bg-background text-muted-foreground/70"
            aria-hidden
          />
        )}
        <header className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2.5 py-1.5">
          {heading}
          <InfoHint label={label} className="ml-auto shrink-0">
            {hint}
          </InfoHint>
        </header>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2 scroll-thin">
          {children}
        </div>
      </section>
    );
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border bg-surface/60"
      data-testid="factory-view-stage"
      data-stage={label}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        {heading}
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </section>
  );
}

/**
 * The lane of work waiting on a person: escalated, failed, and anything stuck. A failed card
 * carries Retry, so stopped work runs again from here (its open PR back to review).
 */
function NeedsYou({
  projectId,
  cards,
  now,
  onOpen,
  wide,
}: {
  projectId: string;
  cards: ViewCard[];
  now: number;
  onOpen: (card: ViewCard) => void;
  wide: boolean;
}) {
  const headingId = useId();
  if (cards.length === 0)
    return (
      <p className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
        <UserRound className="size-3" aria-hidden /> Nothing failed or waits on you.
      </p>
    );
  return (
    <section
      aria-labelledby={headingId}
      // On wide screens the lane takes at most about a third of the height and scrolls, so a
      // long list never pushes the pipeline out of reach.
      className={cn(
        "flex flex-col rounded-xl border border-status-waiting/40 bg-status-waiting/[0.04] p-2",
        wide && "max-h-[min(34vh,20rem)] shrink-0",
      )}
      data-testid="factory-view-needs-you"
    >
      <h2
        id={headingId}
        className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] font-medium text-status-waiting"
      >
        <UserRound className="size-3.5 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">{NEEDS_YOU_LABEL}</span>
        <span className="rounded-full bg-status-waiting/12 px-1.5 text-[10px] leading-4 tabular-nums">
          {cards.length}
        </span>
        <span className="hidden truncate font-normal text-muted-foreground sm:inline">
          Failed or escalated work that waits for a person
        </span>
      </h2>
      <ul
        className={cn(
          "grid gap-1.5",
          wide ? "min-h-0 grid-cols-4 overflow-y-auto scroll-thin" : "grid-cols-1 sm:grid-cols-2",
        )}
        data-testid="factory-view-needs-you-list"
      >
        {cards.map((c) => (
          <li key={c.item.id} className="flex flex-col gap-1">
            <ViewCardButton card={c} now={now} onOpen={onOpen} />
            {c.item.stage === "failed" && (
              <RetryButton
                projectId={projectId}
                itemId={c.item.id}
                pr={openPrOf(c.item)}
                variant="outline"
                className="self-start"
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Factory view's pipeline: Intake → Identify type → Building → Reviewing → Merge queue → Merged. */
export function PipelineBoard({
  f,
  pipeline,
  now,
  onOpen,
}: {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  now: number;
  onOpen: (card: ViewCard) => void;
}) {
  const wide = useWide();
  const announcement = useMoveAnnouncement(pipeline);
  const scout = f.mode === "dark_factory" ? f.scout : null;
  const ignored = f.ignored.length;
  const extra = (id: ViewStageId) => (id === "intake" ? (scout ? 1 : 0) : 0);
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", wide && "flex-1")}>
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="factory-view-live"
      >
        {announcement}
      </div>
      <NeedsYou
        projectId={f.projectId}
        cards={pipeline.needsYou}
        now={now}
        onOpen={onOpen}
        wide={wide}
      />
      <div
        // Six columns that never squeeze a card below a readable width: past that the pipeline
        // scrolls sideways instead.
        className={cn(
          wide
            ? "grid min-h-[20rem] flex-1 grid-cols-[repeat(6,minmax(9rem,1fr))] gap-2 overflow-x-auto scroll-thin"
            : "flex flex-col gap-2",
        )}
        data-testid="factory-view-pipeline"
      >
        {VIEW_STAGES.map((stage, i) => {
          const cards = pipeline.stages[stage.id];
          return (
            <Stage
              key={stage.id}
              label={stage.label}
              hint={stage.hint}
              count={cards.length + extra(stage.id)}
              wide={wide}
              last={i === VIEW_STAGES.length - 1}
            >
              <div className="flex flex-col gap-1.5">
                {stage.id === "intake" && scout && <ScoutCard scout={scout} />}
                <Cards
                  cards={cards}
                  now={now}
                  onOpen={onOpen}
                  empty={stage.id === "intake" && scout ? undefined : "Nothing here"}
                />
                {stage.id === "intake" && ignored > 0 && (
                  <p
                    className="px-1 text-[10px] text-status-waiting"
                    title="Issues from authors who aren't trusted. Let them in from the factory panel."
                  >
                    {ignored} ignored (untrusted authors)
                  </p>
                )}
              </div>
            </Stage>
          );
        })}
      </div>
    </div>
  );
}
