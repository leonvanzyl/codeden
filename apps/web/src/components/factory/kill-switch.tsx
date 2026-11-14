import type { FactoryDrainStatus, KillSwitchMode, KillSwitchResponse } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Play, Power } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

type Scope = { projectId: string } | "global";
/** What the confirmation asks about. */
type Confirm = "drain" | "now" | "release";

/** The drain's optional time limit, in minutes ("none": no limit). */
const LIMITS = [
  { value: "none", label: "No time limit" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
] as const;

const COPY: Record<
  Confirm,
  { title: (global: boolean) => string; body: (global: boolean) => string }
> = {
  drain: {
    title: () => "Finish current work, then stop?",
    body: () =>
      "The factory takes on no new work: no new issues, builds or scout rounds. Work in flight carries on until it merges, fails or needs you, with the usual checks; then the factory stops by itself. Queued items stay queued.",
  },
  now: {
    title: (global) => (global ? "Stop every project's factory now?" : "Stop this factory now?"),
    body: (global) =>
      `This stops the loop and every factory session${global ? " in every project" : " in this project"} immediately. Items being built go back to the backlog; open PRs stay open.`,
  },
  release: {
    title: (global) => (global ? "Let factories run again?" : "Release the kill switch?"),
    body: () =>
      "The loop picks up backlog items again within your limits. A paused loop stays paused until you resume it.",
  },
};

function toastResult(res: KillSwitchResponse, global: boolean, mode: KillSwitchMode | "off") {
  if (res.draining) {
    const n = res.inFlight;
    toast.success("Finishing current work", {
      description: `${n} item${n === 1 ? "" : "s"} in flight; the factory stops once ${n === 1 ? "it finishes" : "they finish"}.`,
    });
  } else if (res.on && mode === "drain") {
    toast.warning("Factory stopped", { description: "Nothing was in flight." });
  } else if (res.on) {
    const n = res.stoppedSessions.length;
    toast.warning(global ? "Every factory stopped" : "Factory stopped", {
      description: `${n} factory session${n === 1 ? "" : "s"} halted.`,
    });
  } else toast.success(global ? "Factories may run again" : "Factory resumed");
}

/**
 * The kill switch (§10.1) with a confirmation: one project's, or every project's (`global`).
 * A project's offers **Finish current work, then stop** (a drain, first) and **Stop now**; while
 * it drains, **Resume** and **Stop now**; once stopped, **Release kill switch**. The global
 * switch only stops now.
 */
export function KillSwitchButton({
  scope,
  on,
  drain = null,
  size = "sm",
}: {
  scope: Scope;
  /** The switch's current state. */
  on: boolean;
  /** The drain in progress (`FactoryStatus.drain`). */
  drain?: FactoryDrainStatus | null;
  size?: "sm" | "xs";
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const global = scope === "global";
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [limit, setLimit] = useState<string>("none");
  const kill = useMutation({
    mutationFn: (req: { on: boolean; mode?: KillSwitchMode; drainLimitMin?: number | null }) =>
      client.factory.killSwitch(scope, req.on, {
        mode: req.mode,
        drainLimitMin: req.drainLimitMin,
      }),
    onSuccess: (res, req) => {
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
      toastResult(res, global, req.on ? (req.mode ?? "now") : "off");
    },
    onError: (e) => toast.error("Couldn't change the kill switch", { description: e.message }),
  });
  const act = (which: Confirm) => {
    if (which === "release") kill.mutate({ on: false });
    else if (which === "now") kill.mutate({ on: true, mode: "now" });
    else kill.mutate({ on: true, mode: "drain", drainLimitMin: limit === "none" ? null : +limit });
  };
  const ask = (which: Confirm) => {
    if (which === "drain") setLimit("none");
    setConfirm(which);
  };

  let controls: ReactNode;
  if (on) {
    controls = (
      <Button
        size={size}
        variant="outline"
        disabled={kill.isPending}
        onClick={() => ask("release")}
      >
        <Power /> {global ? "Release global kill switch" : "Release kill switch"}
      </Button>
    );
  } else if (global) {
    controls = (
      <Button
        size={size}
        variant="destructive"
        disabled={kill.isPending}
        onClick={() => ask("now")}
      >
        <Power /> Stop every factory
      </Button>
    );
  } else if (drain) {
    controls = (
      <>
        <Button
          size={size}
          disabled={kill.isPending}
          onClick={() => kill.mutate({ on: false })}
          title="Cancel the drain: the factory takes on new work again"
          data-testid="factory-drain-resume"
        >
          <Play /> Resume
        </Button>
        <Button
          size={size}
          variant="destructive"
          disabled={kill.isPending}
          onClick={() => ask("now")}
        >
          <Power /> Stop now
        </Button>
      </>
    );
  } else {
    controls = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size} variant="destructive" disabled={kill.isPending}>
            <Power /> Kill switch <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => ask("drain")} data-testid="kill-switch-drain">
            <div>
              <div className="font-medium">Finish current work, then stop</div>
              <div className="text-2xs text-muted-foreground">
                Nothing new starts; work in flight finishes first.
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => ask("now")}
            variant="destructive"
            data-testid="kill-switch-now"
          >
            <div>
              <div className="font-medium">Stop now</div>
              <div className="text-2xs text-muted-foreground">
                Every factory session stops immediately.
              </div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      {controls}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        {confirm && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{COPY[confirm].title(global)}</AlertDialogTitle>
              <AlertDialogDescription>{COPY[confirm].body(global)}</AlertDialogDescription>
            </AlertDialogHeader>
            {confirm === "drain" && (
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-muted-foreground" id="drain-limit-hint">
                  If work is still in flight after this long, stop it all at once
                </span>
                <Select value={limit} onValueChange={setLimit}>
                  <SelectTrigger
                    className="h-8 w-40 text-[13px]"
                    aria-label="Drain time limit"
                    aria-describedby="drain-limit-hint"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIMITS.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => act(confirm)}
                variant={confirm === "now" ? "destructive" : "default"}
              >
                {confirm === "release"
                  ? "Release"
                  : confirm === "drain"
                    ? "Finish, then stop"
                    : "Stop everything"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
