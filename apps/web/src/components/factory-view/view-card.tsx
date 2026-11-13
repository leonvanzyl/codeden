import type { WorkType } from "@codeden/contracts";
import { AlertTriangle, ListChecks, RotateCcw, ShieldAlert, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { PR_STATE_LABEL, TYPE_LABEL } from "@/components/factory/meta";
import { ageShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type CardState, cardNumber, cardStateLabel, prLabel, type ViewCard } from "./stages";

const PR_LABELS = Object.fromEntries(
  Object.entries(PR_STATE_LABEL).map(([state, meta]) => [state, meta.label]),
);

const TYPE_CLASS: Record<WorkType, string> = {
  bug: "bg-status-failed/10 text-status-failed",
  feature: "bg-primary/10 text-primary",
  docs: "bg-muted text-muted-foreground",
};

/**
 * A short type badge: Bug, Feature or Docs. Inside a narrow card (a container under 9.5rem)
 * a feature reads "Feat", so the time beside it still fits.
 */
export function TypeBadge({
  type,
  fit = false,
}: {
  type: WorkType | null;
  /** Inside a card: shorten to fit its width. */
  fit?: boolean;
}) {
  if (!type) return null;
  const label = type === "docs" ? "Docs" : TYPE_LABEL[type];
  return (
    <span
      className={cn(
        "min-w-0 truncate rounded px-1 text-[10px] leading-4 font-medium",
        TYPE_CLASS[type],
      )}
      title={TYPE_LABEL[type]}
    >
      {type === "feature" && fit ? (
        <>
          <span className="@[9.5rem]:hidden">Feat</span>
          <span className="hidden @[9.5rem]:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/**
 * The state marker. Running pulses only when motion is allowed (`motion-safe`), so reduced
 * motion keeps every card still.
 */
export function StateMarker({ state, className }: { state: CardState; className?: string }) {
  if (state === "person")
    return (
      <UserRound className={cn("size-3 shrink-0 text-status-waiting", className)} aria-hidden />
    );
  if (state === "failed")
    return (
      <AlertTriangle className={cn("size-3 shrink-0 text-status-failed", className)} aria-hidden />
    );
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        state === "running"
          ? "bg-status-running motion-safe:animate-pulse"
          : "bg-status-idle/70 ring-2 ring-status-idle/20",
        className,
      )}
    />
  );
}

/** A small rounded label on a card: a revise round, the PR's state, the checks. */
function Pill({
  tone,
  title,
  children,
}: {
  tone?: "person" | "failed";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-[10px] leading-4",
        tone === "person" && "border-status-waiting/40 text-status-waiting",
        tone === "failed" && "border-status-failed/40 text-status-failed",
        !tone && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** One work item on the Factory view: a button that opens its side sheet. */
export function ViewCardButton({
  card,
  now,
  onOpen,
}: {
  card: ViewCard;
  now: number;
  onOpen: (card: ViewCard) => void;
}) {
  const w = card.item;
  const number = cardNumber(w);
  const pr = prLabel(card.pr, PR_LABELS);
  // The checks matter while it's reviewed and queued; elsewhere they're old news.
  const checks = card.place === "reviewing" || card.place === "merge" ? w.checks : null;
  const since = ageShort(card.since, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`${number} ${w.title}, ${cardStateLabel(card)}`}
      data-testid="factory-view-card"
      data-state={card.state}
      className={cn(
        "group @container w-full animate-rise rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        card.state === "person" && "border-status-waiting/50 bg-status-waiting/[0.05]",
        card.state === "failed" && "border-status-failed/50 bg-status-failed/[0.05]",
        card.state !== "person" && card.state !== "failed" && "border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <StateMarker state={card.state} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{number}</span>
        <TypeBadge type={w.type} fit />
        {w.trust === "admitted" && (
          <ShieldAlert
            className="size-3 shrink-0 text-status-waiting"
            aria-label="Let in from an untrusted author"
          />
        )}
        <span
          className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums"
          title={`In this step since ${new Date(card.since).toLocaleString()}`}
        >
          {since === "now" ? "just now" : since}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug font-medium">{w.title}</div>
      {(w.attempts > 0 || pr || checks) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {w.attempts > 0 && (
            <Pill tone="person" title={`Revise round ${w.attempts}`}>
              <RotateCcw className="size-2.5" aria-hidden /> {w.attempts}
            </Pill>
          )}
          {pr && (
            <Pill
              tone={
                card.pr?.state === "stuck" || card.pr?.state === "waiting_for_you"
                  ? "person"
                  : undefined
              }
            >
              {pr}
            </Pill>
          )}
          {checks && (
            <Pill
              tone={checks.failed > 0 ? "failed" : undefined}
              title={`${checks.passed} of ${checks.total} merge checks passed${checks.failed ? `, ${checks.failed} failed` : ""}`}
            >
              <ListChecks className="size-2.5" aria-hidden /> {checks.passed}/{checks.total}
            </Pill>
          )}
        </div>
      )}
      <div className="mt-0.5 truncate text-2xs text-muted-foreground">{card.activity}</div>
    </button>
  );
}
