import type { FactoryStatus, FactoryWorkItem, PipelineStep, WorkType } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, RotateCcw, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { StatusDot } from "@/components/common/status-dot";
import { statusTone, type Tone } from "@/lib/format";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { stepLabel } from "./meta";
import { Badge, type Kind } from "./node-badge";
import { ScoutNode } from "./scout-node";

/**
 * The factory's pipelines as a live diagram (§10.1): Issue → Identify type → the Bug, Feature
 * and Docs lanes → Merge. Every work item sits on the node of its current step; clicking it
 * opens the agent session working on it (or the item, when no agent has it yet).
 */

const MAX_CHIPS = 4;

/** Where an item is drawn: its lane (null before classification) and its node. */
function place(w: FactoryWorkItem): { lane: WorkType | null; node: PipelineStep } {
  // Items from before the pipelines existed have no type once they started: the feature lane.
  const lane = w.type ?? (w.step === "intake" ? null : "feature");
  if (w.step === "queued") {
    if (lane === "bug") return { lane, node: "reproduce" };
    if (lane === "feature") return { lane, node: "analyze" };
    return { lane, node: "implement" };
  }
  return { lane, node: w.step };
}

function Chip({
  w,
  projectId,
  tone,
  queued,
}: {
  w: FactoryWorkItem;
  projectId: string;
  tone: Tone;
  queued?: boolean;
}) {
  const navigate = useNavigate();
  const label = w.issue ? `#${w.issue.number}` : w.pr ? `PR #${w.pr.number}` : w.title.slice(0, 18);
  const sessionId = queued ? null : w.activeSessionId;
  const open = () =>
    sessionId
      ? void navigate({ to: "/sessions/$sessionId", params: { sessionId } })
      : void navigate({
          to: "/projects/$projectId/factory/$itemId",
          params: { projectId, itemId: w.id },
        });
  const hint = [
    w.title,
    queued ? "Waiting for a free agent" : null,
    w.trust === "admitted" ? "Let in by hand: a person merges it" : null,
    w.attempts > 0 ? `Revise round ${w.attempts}` : null,
    w.note,
    sessionId ? "Click to open the agent's session" : "Click to open the item",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      onClick={open}
      title={hint}
      data-testid="pipeline-chip"
      data-step={w.step}
      className={cn(
        "flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 transition-colors hover:border-primary/60 hover:bg-primary/[0.06]",
        queued
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-surface text-foreground",
        w.stage === "escalated" && "border-status-waiting/50 text-status-waiting",
      )}
    >
      {w.stage === "escalated" ? (
        <AlertTriangle className="size-2.5 shrink-0" />
      ) : (
        <StatusDot tone={queued ? "idle" : tone} className="size-1.5 [&>span]:size-1.5" />
      )}
      <span className="truncate font-mono">{label}</span>
      {w.trust === "admitted" && <ShieldAlert className="size-2.5 shrink-0 text-status-waiting" />}
      {w.attempts > 0 && !queued && (
        <RotateCcw className="size-2.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function Node({
  kind,
  title,
  items,
  queued = [],
  projectId,
  toneOf,
  className,
  footer,
}: {
  kind: Kind;
  title: string;
  items: FactoryWorkItem[];
  queued?: FactoryWorkItem[];
  projectId: string;
  toneOf: (w: FactoryWorkItem) => Tone;
  className?: string;
  footer?: ReactNode;
}) {
  const shown = [...items, ...queued];
  const extra = shown.length - MAX_CHIPS;
  const active = items.length > 0;
  return (
    <div
      className={cn(
        "relative flex min-h-[64px] min-w-0 flex-col items-center gap-1.5 rounded-lg border bg-card px-2 pt-3.5 pb-2 text-center",
        active ? "border-primary/50 shadow-[0_0_0_3px] shadow-primary/10" : "border-border",
        className,
      )}
      data-testid="pipeline-node"
      data-node={title}
    >
      <Badge kind={kind} />
      <span className="text-[12px] leading-tight font-medium">{title}</span>
      {shown.length > 0 && (
        <div className="flex w-full flex-wrap justify-center gap-1">
          {items.slice(0, MAX_CHIPS).map((w) => (
            <Chip key={w.id} w={w} projectId={projectId} tone={toneOf(w)} />
          ))}
          {queued.slice(0, Math.max(0, MAX_CHIPS - items.length)).map((w) => (
            <Chip key={w.id} w={w} projectId={projectId} tone="idle" queued />
          ))}
          {extra > 0 && <span className="text-[10px] text-muted-foreground">+{extra}</span>}
        </div>
      )}
      {footer}
    </div>
  );
}

function Arrow({ dashed }: { dashed?: boolean }) {
  return (
    <span className="flex items-center text-muted-foreground/70" aria-hidden>
      <span
        className={cn(
          "h-px w-3",
          dashed ? "border-t border-dashed border-muted-foreground/60" : "bg-muted-foreground/60",
        )}
      />
      <ArrowRight className="-ml-1 size-3" />
    </span>
  );
}

/** The bracket that fans the type out into the three lanes, or gathers them into Merge. */
function Fan({ side }: { side: "out" | "in" }) {
  return (
    <div className="relative grid w-6 shrink-0 grid-rows-3 self-stretch" aria-hidden>
      <span className="absolute top-[16.6%] bottom-[16.6%] left-1/2 border-l border-muted-foreground/50" />
      <span
        className={cn(
          "absolute top-1/2 h-px w-1/2 bg-muted-foreground/50",
          side === "out" ? "left-0" : "right-0",
        )}
      />
      {[0, 1, 2].map((i) => (
        <span key={i} className="relative">
          <span
            className={cn(
              "absolute top-1/2 h-px w-1/2 bg-muted-foreground/50",
              side === "out" ? "right-0" : "left-0",
            )}
          />
        </span>
      ))}
    </div>
  );
}

function Lane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative flex items-center gap-1 rounded-lg border border-border bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--color-muted)_6px,var(--color-muted)_7px)] px-2 pt-5 pb-2">
      <span className="absolute top-1 left-2 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function Revise({ count }: { count: number }) {
  return (
    <span
      className={cn(
        "absolute -bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-dashed bg-card px-1.5 text-[9.5px] leading-4",
        count > 0
          ? "border-status-waiting/60 text-status-waiting"
          : "border-border text-muted-foreground",
      )}
      title="A failed review or failed checks send the work back to the builder"
    >
      <RotateCcw className="size-2.5" /> Revise{count > 0 && ` · ${count}`}
    </span>
  );
}

/** The live pipeline diagram of a software or dark factory. */
export function PipelineDiagram({ f }: { f: FactoryStatus }) {
  const { data } = useSnapshot();
  const projectId = f.projectId;
  const sessionStatus = new Map(data?.sessions.map((s) => [s.id, s.status]) ?? []);
  const toneOf = (w: FactoryWorkItem): Tone => {
    const status = w.activeSessionId ? sessionStatus.get(w.activeSessionId) : undefined;
    if (w.step === "merge") return w.stage === "watching" ? "running" : "waiting";
    return status ? statusTone[status] : "idle";
  };
  const live = [...f.backlog, ...f.inProgress, ...f.recent.filter((w) => w.stage === "escalated")];
  const at = (lane: WorkType | null, node: PipelineStep) =>
    live.filter((w) => {
      const p = place(w);
      return p.lane === lane && p.node === node && w.step !== "queued";
    });
  const queuedAt = (lane: WorkType, node: PipelineStep) =>
    live.filter((w) => {
      const p = place(w);
      return w.step === "queued" && p.lane === lane && p.node === node;
    });
  const revising = (lane: WorkType) =>
    live.filter((w) => w.type === lane && w.step === "implement" && w.attempts > 0).length;
  const merge = live.filter((w) => w.step === "merge");
  const node = (lane: WorkType, step: PipelineStep, kind: Kind, className?: string) => (
    <Node
      kind={kind}
      title={stepLabel(step, lane)}
      items={at(lane, step)}
      queued={queuedAt(lane, step)}
      projectId={projectId}
      toneOf={toneOf}
      className={cn("flex-1", className)}
    />
  );
  const dark = f.mode === "dark_factory" && f.scout;
  const ignored = f.ignored.length;

  return (
    <div className="overflow-x-auto scroll-thin" data-testid="pipeline-diagram">
      <div className="flex min-w-[880px] items-stretch gap-1 py-2">
        {dark && f.scout && (
          <div className="flex items-center gap-1">
            <ScoutNode scout={f.scout} />
            <Arrow dashed />
          </div>
        )}
        <div className="flex items-center gap-1">
          <Node
            kind={dark ? "humanOrScout" : "human"}
            title="Issue"
            items={[]}
            projectId={projectId}
            toneOf={toneOf}
            className="w-[96px] shrink-0"
            footer={
              <span
                className={cn(
                  "text-[10px]",
                  ignored > 0 ? "text-status-waiting" : "text-muted-foreground",
                )}
                title="Issues from authors who aren't trusted are ignored until you let them in"
              >
                {ignored > 0 ? `${ignored} ignored` : "trusted authors"}
              </span>
            }
          />
          <Arrow dashed />
          <Node
            kind="llm"
            title="Identify type"
            items={at(null, "intake")}
            projectId={projectId}
            toneOf={toneOf}
            className="w-[112px] shrink-0"
          />
        </div>
        <Fan side="out" />
        <div className="grid min-w-0 flex-1 grid-rows-3 gap-2.5">
          <Lane label="Bug">
            {node("bug", "reproduce", "workspace")}
            <Arrow />
            {node("bug", "implement", "workspace")}
            <Arrow />
            <div className="relative flex flex-1">
              {node("bug", "review", "workspace")}
              <Revise count={revising("bug")} />
            </div>
          </Lane>
          <Lane label="Feature">
            {node("feature", "analyze", "agent")}
            <Arrow />
            {node("feature", "implement", "workspace")}
            <Arrow />
            <div className="relative flex flex-1">
              {node("feature", "review", "workspace")}
              <Revise count={revising("feature")} />
            </div>
          </Lane>
          <Lane label="Documentation">
            {node("docs", "implement", "workspace", "flex-[2]")}
            <Arrow dashed />
            {node("docs", "review", "checks", "flex-1")}
          </Lane>
        </div>
        <Fan side="in" />
        <div className="flex items-center">
          <Node
            kind={f.limits.autoMerge ? "auto" : "human"}
            title="Merge"
            items={merge}
            projectId={projectId}
            toneOf={toneOf}
            className="w-[120px] shrink-0"
            footer={
              <span className="text-[10px] text-muted-foreground">
                {f.limits.autoMerge ? "when every check passes" : "ready for you on GitHub"}
              </span>
            }
          />
        </div>
      </div>
    </div>
  );
}
