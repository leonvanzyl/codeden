import type {
  ConflictDecision,
  ConflictRecord,
  StartSessionRequestInit,
  StartSessionResponse,
} from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Clock, GitMerge, ListPlus, SkipForward, Swords, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/common/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type CodeDenClient, useClient } from "@/lib/api";
import { ago } from "@/lib/format";
import { LOCAL_CONFLICT_PREFIX } from "@/lib/new-session";

const startedBy = {
  user: "You",
  orchestrator: "The orchestrator",
  pm: "The PM",
  automation: "An automation",
};

const doneText: Record<ConflictDecision["resolution"], string> = {
  wait: "Queued behind the running work",
  skip: "Skipped",
  join: "Sent to the running session",
  force: "Started anyway",
};

async function decide(
  client: CodeDenClient,
  conflict: ConflictRecord,
  decision: ConflictDecision,
): Promise<StartSessionResponse> {
  if (!conflict.id.startsWith(LOCAL_CONFLICT_PREFIX))
    return (await client.resolveConflict(conflict.id, decision)).result;
  const start = conflict.start as StartSessionRequestInit;
  return client.startSession({ ...start, conflict: decision });
}

/** What a resolved conflict led to: a session start, an automation run, or nothing. */
export interface ConflictOutcome {
  status: string;
  sessionId?: string | null;
}

/**
 * A start request that matched running work (§8.4). The same four choices the agents get:
 * wait (queue behind), skip, join (send as a follow-up) or force (with a recorded reason).
 * `decideWith` replaces the retry of the saved request: an automation's run now, or the New
 * session draft as it is when the decision is made.
 * `replace` opens the resulting session in place of the current history entry (the New session
 * draft becomes that session, so Back doesn't return to an emptied draft).
 */
export function ConflictCard({
  conflict,
  onResolved,
  decideWith,
  replace = false,
}: {
  conflict: ConflictRecord;
  onResolved?: (result: ConflictOutcome) => void;
  decideWith?: (decision: ConflictDecision) => Promise<ConflictOutcome>;
  replace?: boolean;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [forcing, setForcing] = useState(false);
  const [reason, setReason] = useState("");
  const existing = conflict.existing[0];
  const resolve = useMutation({
    mutationFn: (decision: ConflictDecision): Promise<ConflictOutcome> =>
      decideWith ? decideWith(decision) : decide(client, conflict, decision),
    onSuccess: (result, decision) => {
      toast.success(doneText[decision.resolution]);
      void queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      onResolved?.(result);
      const moved = ["started", "joined", "queued"].includes(result.status);
      if (moved && result.sessionId)
        void navigate({
          to: "/sessions/$sessionId",
          params: { sessionId: result.sessionId },
          replace,
        });
    },
    onError: (e) => toast.error("Couldn't resolve the conflict", { description: e.message }),
  });

  return (
    <div
      className="overflow-hidden rounded-xl border border-chart-5/30 bg-card"
      data-testid="conflict-card"
    >
      <div className="flex items-center gap-2 border-b border-chart-5/15 bg-chart-5/[0.06] px-3.5 py-2">
        <Swords className="size-4 text-chart-5" />
        <span className="text-2xs font-semibold tracking-wider text-chart-5 uppercase">
          Already running
        </span>
        <span className="text-3xs text-muted-foreground">{ago(conflict.createdAt)}</span>
        <code className="ml-auto rounded bg-background/60 px-1.5 py-px font-mono text-3xs text-muted-foreground">
          {conflict.request.workKey}
        </code>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-[13px]">
          <span className="font-medium">{startedBy[conflict.request.startedBy.kind]}</span> asked to{" "}
          <span className="font-medium">“{conflict.request.purpose}”</span>, but matching work is
          already in progress:
        </p>
        {conflict.existing.map((work) => (
          <div
            key={work.id}
            className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <StatusDot tone={work.status === "running" ? "running" : "waiting"} className="mt-1" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{work.purpose}</div>
              <div className="text-2xs text-muted-foreground">
                {startedBy[work.startedBy.kind]} · {work.status} · {ago(work.startedAt)}
                {work.progress && ` · ${work.progress.text}`}
              </div>
            </div>
            {work.sessionId && (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: work.sessionId }}
                className="shrink-0 text-2xs text-primary hover:underline"
              >
                Open
              </Link>
            )}
          </div>
        ))}
        {forcing ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why start a duplicate? (recorded)"
              aria-label="Reason to start anyway"
              className="h-8 text-[13px]"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={!reason.trim() || resolve.isPending}
              onClick={() => resolve.mutate({ resolution: "force", reason: reason.trim() })}
            >
              Start anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForcing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              onClick={() => resolve.mutate({ resolution: "wait", behindId: existing?.id })}
              disabled={resolve.isPending}
            >
              <Clock /> Wait
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!existing?.sessionId || resolve.isPending}
              onClick={() =>
                existing?.sessionId &&
                resolve.mutate({ resolution: "join", sessionId: existing.sessionId })
              }
            >
              <GitMerge /> Join
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => resolve.mutate({ resolution: "skip" })}
              disabled={resolve.isPending}
            >
              <SkipForward /> Skip
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setForcing(true)}
            >
              <Zap /> Force…
            </Button>
            <span className="ml-auto flex items-center gap-1 self-center text-3xs text-muted-foreground/70">
              <ListPlus className="size-3" /> Wait queues it to start when the current run finishes
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
