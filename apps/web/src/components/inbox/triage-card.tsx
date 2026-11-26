import type { InboxItem, TriageDecisionResponse } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, CircleDot, ExternalLink, Filter, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";

/** "Should I take this on? #12 Fix the login" -> the issue title part. */
function questionOf(item: InboxItem): string {
  return item.title.replace(/^Should I take this on\?\s*/, "") || item.title;
}

/**
 * A triage decision (§10, §11.1): the PM classified a new issue as ready and asks whether to
 * take it on. Shows its classification and rationale; accept starts a session for the issue,
 * decline closes the decision with an optional reason.
 */
export function TriageCard({ item }: { item: InboxItem }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const open = item.status === "open";
  const fail = (e: Error) =>
    toast.error("Couldn't record the decision", { description: e.message });

  const onAccepted = (res: TriageDecisionResponse) => {
    const start = res.start;
    if (start?.status === "conflict" && res.item.status !== "open") {
      // The issue's work was already running: the decision closed, nothing new started.
      const running = start.existing.find((w) => w.sessionId)?.sessionId ?? null;
      toast.info("Already being worked on", {
        description: "No new session started.",
        action: running
          ? {
              label: "Open session",
              onClick: () =>
                void navigate({ to: "/sessions/$sessionId", params: { sessionId: running } }),
            }
          : undefined,
      });
      return;
    }
    if (start?.status === "conflict") {
      void queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      toast.warning("Matching work is already running", {
        description: "Decide on the conflict card in your inbox.",
      });
      return;
    }
    const sessionId = start && "sessionId" in start ? start.sessionId : null;
    toast.success(start?.status === "queued" ? "Queued behind running work" : "Taking it on", {
      action: sessionId
        ? {
            label: "Open session",
            onClick: () => void navigate({ to: "/sessions/$sessionId", params: { sessionId } }),
          }
        : undefined,
    });
  };
  const accept = useMutation({
    mutationFn: () => client.automations.acceptTriage(item.id),
    onSuccess: onAccepted,
    onError: fail,
  });
  const decline = useMutation({
    mutationFn: () =>
      client.automations.declineTriage(item.id, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: () => toast.success("Declined; the issue keeps its triage labels"),
    onError: fail,
  });
  const busy = accept.isPending || decline.isPending;

  return (
    <div className="rounded-xl border border-border bg-card" data-testid="triage-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-2xs">
        <Filter className="size-3.5 text-primary" />
        <span className="font-semibold tracking-wider text-primary uppercase">
          Should I take this on?
        </span>
        <span
          className="ml-auto rounded-full bg-status-done/12 px-2 py-px font-medium text-status-done"
          data-testid="triage-classification"
          title="The PM's triage classification"
        >
          PM: Ready
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="flex items-start gap-2">
          <CircleDot className="mt-0.5 size-4 shrink-0 text-status-done" />
          <h3 className="min-w-0 flex-1 text-[14px] font-medium">{questionOf(item)}</h3>
          {item.issue && (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => item.issue && platform.openExternal(item.issue.url)}
            >
              <ExternalLink /> Issue
            </Button>
          )}
        </div>
        {item.body && (
          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="text-3xs font-medium tracking-wider text-muted-foreground uppercase">
              PM's rationale
            </div>
            <p className="mt-1 text-[13px] leading-relaxed" data-testid="triage-rationale">
              {item.body}
            </p>
          </div>
        )}
        {!open ? (
          <p className="text-2xs text-muted-foreground">
            {item.status === "resolved" ? "Accepted" : "Declined"}
          </p>
        ) : declining ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why not? (optional, kept with the decision)"
              aria-label="Reason to decline"
              className="h-8 text-[13px]"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => decline.mutate()}
            >
              Decline
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => accept.mutate()} disabled={busy}>
              <Check /> {accept.isPending ? "Starting…" : "Take it on"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setDeclining(true)}
              disabled={busy}
            >
              <X /> Decline…
            </Button>
            <span className="ml-auto text-3xs text-muted-foreground">
              Take it on starts an agent session for the issue
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
