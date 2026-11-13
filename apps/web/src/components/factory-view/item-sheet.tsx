import type { FactoryItem } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { Check, CircleDot, ExternalLink, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import { SectionLabel } from "@/components/common/bits";
import { CheckRow, SessionLink } from "@/components/factory/item-parts";
import { PR_STATE_LABEL, STAGE_LABEL, stepLabel } from "@/components/factory/meta";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryItem } from "@/lib/factory";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { cardNumber, cardStateLabel, type ViewCard } from "./stages";
import { stepTrail } from "./step-trail";
import { StateMarker, TypeBadge } from "./view-card";

function Trail({ item, card }: { item: FactoryItem; card: ViewCard }) {
  const trail = stepTrail({ type: item.type, step: card.item.step, stage: card.item.stage });
  return (
    <ol className="flex flex-col gap-1" aria-label="Pipeline steps">
      {trail.map(({ step, mark, note }) => (
        <li
          key={step}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px]",
            mark === "current" && "bg-primary/10 font-medium text-foreground",
            mark === "next" && "text-muted-foreground",
          )}
          aria-current={mark === "current" ? "step" : undefined}
        >
          {mark === "done" ? (
            <Check className="size-3.5 text-status-done" aria-hidden />
          ) : (
            <span
              aria-hidden
              className={cn(
                "mx-[3px] size-2 rounded-full",
                mark === "current" ? "bg-primary" : "border border-muted-foreground/50",
              )}
            />
          )}
          <span>
            {stepLabel(step, item.type)}
            {note && (
              <span className="block text-2xs font-normal text-muted-foreground">{note}</span>
            )}
          </span>
          {mark === "current" && <span className="sr-only">(current step)</span>}
        </li>
      ))}
    </ol>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function ExternalButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline"
      onClick={() => platform.openExternal(url)}
    >
      {children}
    </button>
  );
}

function Body({ projectId, card }: { projectId: string; card: ViewCard }) {
  const { data: item, error } = useFactoryItem(projectId, card.item.id);
  if (error) return <p className="px-4 text-2xs text-muted-foreground">{error.message}</p>;
  if (!item) return <Skeleton className="mx-4 h-48 rounded-xl" />;
  const passed = item.checks.filter((c) => c.state === "pass").length;
  return (
    <div className="flex flex-col gap-5 px-4 pb-6">
      {(item.reason || card.activity) && (
        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-2xs",
            card.state === "failed"
              ? "border-status-failed/30 bg-status-failed/[0.06]"
              : card.state === "person"
                ? "border-status-waiting/30 bg-status-waiting/[0.06]"
                : "border-border bg-surface",
          )}
        >
          {card.activity}
        </p>
      )}
      <section>
        <SectionLabel className="mb-1.5">Steps</SectionLabel>
        <Trail item={item} card={card} />
      </section>
      <section className="space-y-2 rounded-xl border border-border bg-card p-3">
        <Fact label="Issue">
          {item.issue ? (
            <ExternalButton url={item.issue.url}>
              <CircleDot className="size-3" />#{item.issue.number}
            </ExternalButton>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Pull request">
          {item.pr ? (
            <ExternalButton url={item.pr.url}>
              <GitPullRequest className="size-3" />#{item.pr.number}
              {card.pr ? ` · ${PR_STATE_LABEL[card.pr.state].label}` : ` · ${item.pr.state}`}
            </ExternalButton>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Builder">
          <SessionLink id={item.builderSessionId} label={item.builderProvider ?? "session"} />
        </Fact>
        <Fact label="Reviewer">
          <SessionLink id={item.reviewerSessionId} label={item.reviewerProvider ?? "session"} />
        </Fact>
        <Fact label="Stage">{STAGE_LABEL[item.stage].label}</Fact>
        {item.attempts > 0 && <Fact label="Revise rounds">{item.attempts}</Fact>}
        <Fact label="In this step">{ago(card.since)}</Fact>
      </section>
      <section>
        <SectionLabel className="mb-1.5">
          Merge checks
          {item.checks.length > 0 && ` · ${passed} of ${item.checks.length} passed`}
        </SectionLabel>
        {item.checks.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            {item.pr
              ? "No merge checks recorded yet."
              : "Checks run once the builder opens a pull request."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {item.checks.map((c) => (
              <CheckRow key={c.name} check={c} />
            ))}
          </div>
        )}
      </section>
      {item.review && (
        <section>
          <SectionLabel className="mb-1.5">Review</SectionLabel>
          <p className="text-2xs leading-relaxed">
            <span className="font-medium capitalize">{item.review.verdict.replace("_", " ")}</span>
            {" · "}
            {item.review.summary.length > 400
              ? `${item.review.summary.slice(0, 400)}…`
              : item.review.summary}
          </p>
        </section>
      )}
      <Link
        to="/projects/$projectId/factory/$itemId"
        params={{ projectId, itemId: item.id }}
        className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
      >
        <ExternalLink className="size-3" /> Open the full item page
      </Link>
    </div>
  );
}

/** A card's details, beside the pipeline: its steps, PR, checks and sessions. */
export function ItemSheet({
  projectId,
  card,
  onClose,
}: {
  projectId: string;
  card: ViewCard | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={card !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto scroll-thin data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        data-testid="factory-view-sheet"
      >
        {card && (
          <>
            <SheetHeader className="pb-3">
              <SheetTitle className="flex items-start gap-2 pr-6 text-[15px] leading-snug">
                <span className="shrink-0 font-mono whitespace-nowrap text-muted-foreground">
                  {cardNumber(card.item)}
                </span>
                <span>{card.item.title}</span>
              </SheetTitle>
              <SheetDescription className="flex items-center gap-1.5 text-2xs">
                {card.state && <StateMarker state={card.state} />}
                {cardStateLabel(card)}
                <TypeBadge type={card.item.type} />
              </SheetDescription>
            </SheetHeader>
            <Body projectId={projectId} card={card} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
