import type { ScoutStatus } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { Check, Radar } from "lucide-react";
import { AREA_LABEL } from "@/components/factory/meta";
import { until } from "@/lib/format";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<ScoutStatus["phase"], string> = {
  idle: "Idle",
  planning: "Planning the round",
  reviewing: "Area reviewers at work",
  filing: "Filing issues",
};

/** The dark factory's scout on the Intake stage: its round, its area reviewers, its findings. */
export function ScoutCard({ scout }: { scout: ScoutStatus }) {
  const active = scout.phase !== "idle";
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed px-2.5 py-2 text-2xs",
        active ? "border-primary/40 bg-primary/[0.04]" : "border-border",
      )}
      data-testid="factory-view-scout"
    >
      <div className="flex items-center gap-1.5">
        <Radar className={cn("size-3.5", active ? "text-primary" : "text-muted-foreground")} />
        {scout.sessionId ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: scout.sessionId }}
            className="text-[12px] font-medium hover:underline"
          >
            Scout
          </Link>
        ) : (
          <span className="text-[12px] font-medium">Scout</span>
        )}
        <span className="text-muted-foreground">
          {active ? `round ${scout.rounds}` : `${scout.rounds} rounds`}
        </span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {PHASE_LABEL[scout.phase]}
        {active && ` · ${scout.findings} found · ${scout.filed} filed`}
        {!active && scout.nextRoundAt && ` · next ${until(scout.nextRoundAt)}`}
      </div>
      {scout.lenses.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Area reviewers">
          {scout.lenses.map((l) => (
            <li key={l.area}>
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: l.sessionId }}
                className="flex items-center gap-1 rounded-full border border-border bg-surface px-1.5 text-[10px] leading-4 hover:border-primary/50"
                title={
                  l.reported
                    ? "Reported its findings"
                    : l.active
                      ? "Reviewing now"
                      : "Waiting to start"
                }
              >
                {l.reported ? (
                  <Check className="size-2.5 text-status-done" />
                ) : (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      l.active ? "bg-status-running motion-safe:animate-pulse" : "bg-status-idle",
                    )}
                  />
                )}
                {AREA_LABEL[l.area]}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
