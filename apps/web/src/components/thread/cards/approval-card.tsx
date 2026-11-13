import type { ApprovalDecision, ItemOf } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PlanApprovalCard } from "./plan-approval-card";

const actionLabel: Record<ItemOf<"approval_request">["action"], string> = {
  command: "Command",
  file_change: "File change",
  outside_worktree: "Outside the worktree",
  network: "Network access",
  git_destructive: "Destructive git",
  secrets: "Secrets access",
  tool: "Tool",
  plan: "Plan",
  other: "Action",
};

const decisionLabel: Record<ApprovalDecision, string> = {
  allow_once: "Approved once",
  allow_session: "Always allowed this session",
  deny: "Denied",
};

/**
 * An approval the agent is waiting on (§11.2), answerable inline. Plan approvals (plan mode)
 * get their own card; `plan` is the plan they approve, for views without the plan card.
 */
export function ApprovalCard({
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
  if (item.action === "plan") {
    return <PlanApprovalCard item={item} sessionId={sessionId} compact={compact} plan={plan} />;
  }
  return <ActionApprovalCard item={item} sessionId={sessionId} compact={compact} />;
}

function ActionApprovalCard({
  item,
  sessionId,
  compact,
}: {
  item: ItemOf<"approval_request">;
  sessionId: string;
  compact: boolean;
}) {
  const client = useClient();
  const pending = item.status === "in_progress";
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.respond(sessionId, item.requestId, { kind: "approval", decision }),
    onError: (e) => toast.error("Couldn't send the decision", { description: e.message }),
  });

  if (!pending) {
    const denied = item.decision === "deny" || item.status === "declined";
    const Icon = denied ? ShieldX : ShieldCheck;
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-[13px] text-muted-foreground">
        <Icon
          className={cn("size-4 shrink-0", denied ? "text-status-failed" : "text-status-done")}
        />
        <span className="min-w-0 truncate">{item.title}</span>
        <span className="ml-auto shrink-0 text-2xs">
          {item.decision ? decisionLabel[item.decision] : "Cancelled"}
          {item.decidedBy && item.decidedBy !== "user" ? ` by ${item.decidedBy}` : ""}
        </span>
      </div>
    );
  }

  const busy = decide.isPending || decide.isSuccess;
  const args = toolArguments(item);
  return (
    <div className="overflow-hidden rounded-xl border border-status-waiting/30 bg-card shadow-[0_0_0_4px] shadow-status-waiting/[0.06] animate-rise">
      <div className="flex items-center gap-2 border-b border-status-waiting/15 bg-status-waiting/[0.07] px-3.5 py-2">
        <ShieldAlert className="size-4 text-status-waiting" />
        <span className="text-2xs font-semibold tracking-wider text-status-waiting uppercase">
          Approval needed
        </span>
        <span className="ml-auto rounded-full border border-status-waiting/25 px-2 py-px text-3xs text-status-waiting/90">
          {actionLabel[item.action]}
        </span>
      </div>
      <div className="space-y-2.5 px-3.5 py-3 wrap-break-word">
        <p className="text-[14px] font-medium">{item.title}</p>
        {item.reason && !compact && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">{item.reason}</p>
        )}
        {item.command && (
          <pre className="overflow-x-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] text-foreground/90 scroll-thin">
            <span className="text-primary/80 select-none">$ </span>
            {item.command}
          </pre>
        )}
        {item.paths && item.paths.length > 0 && (
          <div className="font-mono text-2xs text-muted-foreground">{item.paths.join(" · ")}</div>
        )}
        {item.url && (
          // Only web links reach a card (the contract checks); the user opens it themselves.
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-[12px] text-primary underline-offset-2 hover:underline"
          >
            {item.url}
          </a>
        )}
        {!compact && args && (
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] text-foreground/90 scroll-thin">
            {args}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {item.options.includes("allow_once") && (
            <Button size="sm" disabled={busy} onClick={() => decide.mutate("allow_once")}>
              <Check /> Approve
            </Button>
          )}
          {item.options.includes("allow_session") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => decide.mutate("allow_session")}
            >
              Always allow this session
            </Button>
          )}
          {item.options.includes("deny") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-muted-foreground hover:text-status-failed"
              onClick={() => decide.mutate("deny")}
            >
              Deny
            </Button>
          )}
          {!compact && item.cwd && (
            <span className="ml-auto truncate font-mono text-3xs text-muted-foreground/70">
              {item.cwd}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The arguments of a tool approval (an MCP tool, say), when it has any. */
function toolArguments(item: ItemOf<"approval_request">): string | undefined {
  const input = item.toolInput;
  if (item.action !== "tool" || input === undefined || input === null) return undefined;
  if (typeof input === "object" && Object.keys(input).length === 0) return undefined;
  return JSON.stringify(input, null, 2);
}
