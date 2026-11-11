import type { ItemOf } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, ClipboardCheck, ClipboardList, PencilLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "../markdown";

type Answer = { decision: "allow_once" | "deny"; message?: string };

/**
 * The approval that ends plan mode (`action: "plan"`). Approving lets the agent implement the
 * plan at the session's permission level; "Keep planning" sends optional feedback and the
 * agent revises the plan. `plan` is the plan text, shown where the plan card isn't (inbox).
 */
export function PlanApprovalCard({
  item,
  sessionId,
  compact = false,
  plan,
}: {
  item: ItemOf<"approval_request">;
  sessionId: string;
  compact?: boolean;
  plan?: string;
}) {
  const client = useClient();
  /** Feedback being written for "Keep planning"; null while the box is closed. */
  const [feedback, setFeedback] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: ({ decision, message }: Answer) =>
      client.respond(sessionId, item.requestId, {
        kind: "approval",
        decision,
        ...(message ? { message } : {}),
      }),
    onError: (e) => toast.error("Couldn't send the decision", { description: e.message }),
  });

  if (item.status !== "in_progress") {
    const approved = item.decision !== undefined && item.decision !== "deny";
    const Icon = approved ? ClipboardCheck : ClipboardList;
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-[13px] text-muted-foreground">
        <Icon
          className={cn("size-4 shrink-0", approved ? "text-status-done" : "text-muted-foreground")}
        />
        <span className="min-w-0 truncate">
          {approved ? "Plan approved" : item.decision ? "Kept planning" : "Plan review cancelled"}
        </span>
        {item.decidedBy && item.decidedBy !== "user" && (
          <span className="ml-auto shrink-0 text-2xs">by {item.decidedBy}</span>
        )}
      </div>
    );
  }

  const busy = decide.isPending || decide.isSuccess;
  const keepPlanning = () => decide.mutate({ decision: "deny", message: feedback?.trim() });
  return (
    <div
      className="overflow-hidden rounded-xl border border-primary/30 bg-card shadow-[0_0_0_4px] shadow-primary/[0.06] animate-rise"
      data-testid="plan-approval"
    >
      <div className="flex items-center gap-2 border-b border-primary/15 bg-primary/[0.07] px-3.5 py-2">
        <ClipboardCheck className="size-4 text-primary" />
        <span className="text-2xs font-semibold tracking-wider text-primary uppercase">
          Plan ready
        </span>
      </div>
      <div className="space-y-2.5 px-3.5 py-3 wrap-break-word">
        <p className="text-[14px] font-medium">Start implementing this plan?</p>
        {!compact && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Approve to let the agent make the changes with this session's permissions, or keep it
            planning and say what to change.
          </p>
        )}
        {compact && plan && (
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 scroll-thin">
            <Markdown>{plan}</Markdown>
          </div>
        )}
        {feedback !== null && (
          <Textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
                e.preventDefault();
                keepPlanning();
              }
            }}
            placeholder="What should change in the plan? (optional)"
            aria-label="Feedback on the plan"
            className="min-h-20 text-[13px]"
          />
        )}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {feedback === null ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => decide.mutate({ decision: "allow_once" })}
              >
                <Check /> Approve plan
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setFeedback("")}>
                <PencilLine /> Keep planning
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={keepPlanning}>
                <PencilLine /> Keep planning
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-muted-foreground"
                onClick={() => setFeedback(null)}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
