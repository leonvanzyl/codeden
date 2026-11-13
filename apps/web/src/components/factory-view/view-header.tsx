import type { FactoryStatus, Project } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Factory, Maximize, Minimize, Play, UserRound, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExperimentalBadge } from "@/components/factory/autonomy-dialog";
import { FactoryRunButtons } from "@/components/factory/factory-actions";
import { KillSwitchButton } from "@/components/factory/kill-switch";
import { LOOP_LABEL, MODE_LABEL } from "@/components/factory/meta";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { cn } from "@/lib/utils";

/** Browser full screen for the view (in the desktop app too; F11 there does the same). */
function useFullscreen() {
  const supported = typeof document !== "undefined" && document.fullscreenEnabled === true;
  const [on, setOn] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const update = () => setOn(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggle = () => {
    const done = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    void done?.catch(() => toast.error("Full screen isn't available here"));
  };
  return { supported, on, toggle };
}

function LoopChip({ f }: { f: FactoryStatus }) {
  const stopped = f.killSwitch || f.globalKillSwitch || f.loopState === "stopped";
  const loop = LOOP_LABEL[stopped ? "stopped" : f.loopState];
  const why = f.globalKillSwitch
    ? "global kill switch"
    : f.killSwitch
      ? "kill switch"
      : f.loopState === "paused"
        ? f.pausedReason
        : null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium",
        loop.tone === "failed" && "bg-status-failed/12 text-status-failed",
        loop.tone === "waiting" && "bg-status-waiting/12 text-status-waiting",
        loop.tone === "running" && "bg-status-running/12 text-status-running",
        loop.tone === "idle" && "bg-muted text-muted-foreground",
      )}
      data-testid="factory-view-loop"
      title={why ?? undefined}
    >
      <span className="shrink-0">Loop {loop.label.toLowerCase()}</span>
      {why && <span className="truncate font-normal">· {why}</span>}
    </span>
  );
}

function Count({
  n,
  label,
  tone,
  icon,
}: {
  n: number;
  label: string;
  tone: "waiting" | "failed";
  icon: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs tabular-nums",
        n === 0 && "border-border text-muted-foreground",
        n > 0 &&
          tone === "waiting" &&
          "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
        n > 0 &&
          tone === "failed" &&
          "border-status-failed/40 bg-status-failed/10 text-status-failed",
      )}
      data-testid={`factory-view-count-${tone}`}
    >
      {icon}
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}

/** The Factory view's header: the project, mode and loop, what waits on you, and the controls. */
export function ViewHeader({
  project,
  f,
  needsPerson,
  failed,
}: {
  project: Project;
  f: FactoryStatus;
  needsPerson: number;
  failed: number;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const full = useFullscreen();
  const stopped = f.killSwitch || f.globalKillSwitch || f.loopState === "stopped";
  const resume = useMutation({
    mutationFn: () => client.factory.resume(f.projectId),
    onSuccess: () => {
      toast.success("Loop resumed");
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e) => toast.error("Couldn't resume", { description: e.message }),
  });
  return (
    <header
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5"
      data-testid="factory-view-header"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Factory className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] leading-tight font-semibold">{project.name}</h1>
          <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0">{MODE_LABEL[f.mode]}</span>
            {f.experimental && <ExperimentalBadge />}
          </div>
        </div>
      </div>
      <LoopChip f={f} />
      <div className="flex items-center gap-1.5">
        <Count
          n={needsPerson}
          label="need you"
          tone="waiting"
          icon={<UserRound className="size-3" aria-hidden />}
        />
        <Count
          n={failed}
          label="failed"
          tone="failed"
          icon={<AlertTriangle className="size-3" aria-hidden />}
        />
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {f.loopState === "paused" && !stopped && (
          <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
            <Play /> Resume
          </Button>
        )}
        <FactoryRunButtons f={f} stopped={stopped} />
        <KillSwitchButton scope={{ projectId: f.projectId }} on={f.killSwitch} />
        {full.supported && (
          <Button
            size="sm"
            variant="ghost"
            onClick={full.toggle}
            aria-pressed={full.on}
            data-testid="factory-view-fullscreen"
          >
            {full.on ? <Minimize /> : <Maximize />}
            <span className="hidden sm:inline">{full.on ? "Exit full screen" : "Full screen"}</span>
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild>
          <Link
            to="/projects/$projectId"
            params={{ projectId: f.projectId }}
            // Leaving the view leaves full screen too.
            onClick={() => full.on && void document.exitFullscreen().catch(() => {})}
            data-testid="factory-view-exit"
          >
            <X /> <span className="hidden sm:inline">Exit</span>
            <span className="sr-only sm:hidden">Exit the factory view</span>
          </Link>
        </Button>
      </div>
    </header>
  );
}
