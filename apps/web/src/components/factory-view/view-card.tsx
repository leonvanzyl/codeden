import type { WorkType } from "@codeden/contracts";
import { AlertTriangle, Check, RotateCcw, ShieldAlert, UserRound } from "lucide-react";
import { PR_STATE_LABEL, TYPE_LABEL } from "@/components/factory/meta";
import { ageShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CARD_STATE_LABEL, type CardState, cardNumber, type ViewCard } from "./stages";

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
  if (state === "done")
    return <Check className={cn("size-3 shrink-0 text-status-done", className)} aria-hidden />;
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
  const pr = card.pr;
  const prLabel =
    pr && card.place === "merge"
      ? pr.queuePosition
        ? `Queued #${pr.queuePosition}`
        : PR_STATE_LABEL[pr.state].label
      : null;
  const since = ageShort(card.since, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`${number} ${w.title}, ${CARD_STATE_LABEL[card.state]}`}
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
            className="size-3 text-status-waiting"
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
      <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        {w.attempts > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-status-waiting"
            title={`Revise round ${w.attempts}`}
          >
            <RotateCcw className="size-2.5" aria-hidden />
            {w.attempts}
          </span>
        )}
        {prLabel && (
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 text-[10px] leading-4",
              card.state === "person"
                ? "border-status-waiting/40 text-status-waiting"
                : "border-border",
            )}
          >
            {prLabel}
          </span>
        )}
        <span className="truncate">{card.activity}</span>
      </div>
    </button>
  );
}
