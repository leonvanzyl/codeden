import type { ScoutStatus } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { InfoHint } from "@/components/common/info-hint";
import { StatusDot } from "@/components/common/status-dot";
import { AREA_LABEL, REVIEW_AREAS_HELP, ROUND_HELP, SCOUT_HELP } from "./meta";
import { Badge } from "./node-badge";

/**
 * The dark factory's scout on the pipeline diagram (§10.1): its round and its review areas (one
 * long-lived area reviewer each).
 */
export function ScoutNode({
  scout,
  scheduled = true,
}: {
  scout: ScoutStatus;
  /** False when scheduled rounds are off (`minBacklog` 0): it only runs when started. */
  scheduled?: boolean;
}) {
  const navigate = useNavigate();
  const phase =
    scout.phase === "idle"
      ? !scheduled
        ? "On demand"
        : scout.nextRoundAt
          ? "Resting"
          : "Waiting for a round"
      : scout.phase === "planning"
        ? "Planning"
        : scout.phase === "reviewing"
          ? "Reviewing areas"
          : "Filing issues";
  const roundHint = <InfoHint label="rounds">{ROUND_HELP}</InfoHint>;
  return (
    <div
      className="relative flex min-h-[64px] w-[132px] shrink-0 flex-col items-center gap-1 rounded-lg border border-foreground/30 bg-card px-2 pt-3.5 pb-2 text-center"
      data-testid="pipeline-scout"
    >
      <Badge kind="scout" hint={SCOUT_HELP} />
      <button
        type="button"
        disabled={!scout.sessionId}
        onClick={() =>
          scout.sessionId &&
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: scout.sessionId } })
        }
        className="text-[12px] leading-tight font-medium hover:text-primary disabled:hover:text-foreground"
        title={scout.sessionId ? "Open the scout's session" : undefined}
      >
        Find improvements
      </button>
      <span className="text-[10px] leading-tight text-muted-foreground">
        {phase}
        {scout.rounds > 0 ? (
          <span className="flex items-center justify-center gap-1">
            Round {scout.rounds}
            {roundHint}
          </span>
        ) : (
          <span className="ml-1">{roundHint}</span>
        )}
      </span>
      {scout.lenses.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1" data-testid="scout-areas">
          {scout.lenses.map((l) => (
            <button
              key={l.area}
              type="button"
              onClick={() =>
                void navigate({ to: "/sessions/$sessionId", params: { sessionId: l.sessionId } })
              }
              className="flex items-center gap-1 rounded-md border border-border px-1 text-[10px] hover:border-primary/60"
              title={`${AREA_LABEL[l.area]} review: ${l.reported ? "reported" : "reviewing"}`}
              aria-label={`${AREA_LABEL[l.area]} review: ${l.reported ? "reported" : "reviewing"}. Open its session`}
            >
              <StatusDot
                tone={l.active ? "running" : l.reported ? "done" : "idle"}
                className="size-1.5 [&>span]:size-1.5"
              />
              {AREA_LABEL[l.area]}
            </button>
          ))}
          <InfoHint label="review areas">{REVIEW_AREAS_HELP}</InfoHint>
        </div>
      )}
      {scout.phase === "filing" || scout.filed > 0 ? (
        <span className="text-[10px] text-muted-foreground">{scout.filed} filed this round</span>
      ) : null}
    </div>
  );
}
