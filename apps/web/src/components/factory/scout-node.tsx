import type { ScoutStatus } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { StatusDot } from "@/components/common/status-dot";
import { AREA_LABEL } from "./meta";
import { Badge } from "./node-badge";

/** The dark factory's scout on the pipeline diagram (§10.1): its round and its lenses. */
export function ScoutNode({ scout }: { scout: ScoutStatus }) {
  const navigate = useNavigate();
  const phase =
    scout.phase === "idle"
      ? scout.nextRoundAt
        ? "Resting"
        : "Waiting for a round"
      : scout.phase === "planning"
        ? "Planning"
        : scout.phase === "reviewing"
          ? "Lenses reviewing"
          : "Filing issues";
  return (
    <div
      className="relative flex min-h-[64px] w-[132px] shrink-0 flex-col items-center gap-1 rounded-lg border border-foreground/30 bg-card px-2 pt-3.5 pb-2 text-center"
      data-testid="pipeline-scout"
    >
      <Badge kind="scout" />
      <button
        type="button"
        disabled={!scout.sessionId}
        onClick={() =>
          scout.sessionId &&
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: scout.sessionId } })
        }
        className="text-[12px] leading-tight font-medium hover:text-primary disabled:hover:text-foreground"
        title="The scout reviews the app against the vision on a schedule and files issues"
      >
        Find improvements
      </button>
      <span className="text-[10px] leading-tight text-muted-foreground">
        {phase}
        {scout.rounds > 0 && <span className="block">Round {scout.rounds}</span>}
      </span>
      {scout.lenses.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1">
          {scout.lenses.map((l) => (
            <button
              key={l.area}
              type="button"
              onClick={() =>
                void navigate({ to: "/sessions/$sessionId", params: { sessionId: l.sessionId } })
              }
              className="flex items-center gap-1 rounded-md border border-border px-1 text-[10px] hover:border-primary/60"
              title={`${AREA_LABEL[l.area]} lens: ${l.reported ? "reported" : "reviewing"}`}
            >
              <StatusDot
                tone={l.active ? "running" : l.reported ? "done" : "idle"}
                className="size-1.5 [&>span]:size-1.5"
              />
              {AREA_LABEL[l.area]}
            </button>
          ))}
        </div>
      )}
      {scout.phase === "filing" || scout.filed > 0 ? (
        <span className="text-[10px] text-muted-foreground">{scout.filed} filed this round</span>
      ) : null}
    </div>
  );
}
