import type { MessageSender } from "@codeden/contracts";
import { Factory, Hexagon, type LucideIcon, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { badgePill, RoleBadge } from "@/components/orchestration/role-badge";
import { separateTagLines } from "@/lib/markdown-tags";
import { usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

/** Anyone who writes to a session other than the user. */
export type Sender = Exclude<MessageSender, "user">;

/** Senders that are not a PM or the orchestrator: their header pill. */
const others: Record<
  Exclude<Sender, "pm" | "orchestrator">,
  { label: string; icon: LucideIcon }
> = {
  factory: { label: "Factory", icon: Factory },
  automation: { label: "Automation", icon: Workflow },
  codeden: { label: "CodeDen", icon: Hexagon },
};

const senderName: Record<Sender, string> = {
  pm: "the project manager",
  orchestrator: "the orchestrator",
  factory: "the factory",
  automation: "an automation",
  codeden: "CodeDen",
};

/** Messages longer than this many lines (or characters) are collapsed with "Show more". */
const COLLAPSE_LINES = 12;
const COLLAPSE_CHARS = 1500;

function SenderBadge({ from }: { from: Sender }) {
  if (from === "pm" || from === "orchestrator") return <RoleBadge role={from} />;
  const { label, icon: Icon } = others[from];
  return (
    <span className={badgePill} data-sender-badge={from}>
      <Icon className="size-3" />
      {label}
    </span>
  );
}

/**
 * A message from a PM, the orchestrator, the factory, an automation or CodeDen (a session's
 * opening brief included): rendered Markdown in a card headed by its sender, with a thin primary
 * border and a slow light along it (still under reduced motion). A long one is collapsed after
 * about 12 lines, so the transcript leads with the agent's work.
 */
export function SenderMessage({ from, text }: { from: Sender; text: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const markdown = useMemo(() => separateTagLines(text), [text]);
  const long = text.split("\n").length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;
  const clipped = long && !expanded;
  return (
    <article
      aria-label={`Message from ${senderName[from]}`}
      data-testid="sender-message"
      data-sender={from}
      className={cn(
        "border-shimmer max-w-[80%] min-w-0 rounded-2xl rounded-br-md bg-primary/[0.035] px-3.5 pt-2 pb-2.5",
        !reducedMotion && "animate-border-shimmer",
      )}
    >
      <header className="mb-1.5 flex">
        <SenderBadge from={from} />
      </header>
      {text && (
        <div
          data-clipped={clipped || undefined}
          className={cn(
            clipped &&
              "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
          )}
        >
          <Markdown>{markdown}</Markdown>
        </div>
      )}
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </article>
  );
}
