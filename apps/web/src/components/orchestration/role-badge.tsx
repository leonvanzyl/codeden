import type { Role } from "@codeden/contracts";
import { Bot, Lock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const roleText: Record<Exclude<Role, "agent">, { label: string; short: string }> = {
  orchestrator: { label: "Orchestrator", short: "Orchestrator" },
  pm: { label: "Project manager", short: "PM" },
};

/** The pill a role badge is drawn in (also used for the other message senders). */
export const badgePill =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 text-3xs font-medium text-primary";

/** Role pill for the orchestrator and PM sessions (§8.1). */
export function RoleBadge({
  role,
  short,
  className,
}: {
  role: Role;
  short?: boolean;
  className?: string;
}) {
  if (role === "agent") return null;
  const text = roleText[role];
  return (
    <span className={cn(badgePill, className)} data-role={role}>
      <Bot className="size-3" />
      {short ? text.short : text.label}
    </span>
  );
}

/**
 * Role sessions run read-only (§8.1): no edit tools and no writing commands. They change code
 * by starting and steering agent sessions.
 */
export function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground",
            className,
          )}
          data-testid="read-only-badge"
        >
          <Lock className="size-3" /> Read-only
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Reads the repo and runs read-only commands. Changes happen in agent sessions it starts.
      </TooltipContent>
    </Tooltip>
  );
}
