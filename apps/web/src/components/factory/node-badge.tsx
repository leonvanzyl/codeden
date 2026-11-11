import { cn } from "@/lib/utils";

/** The small label on a pipeline diagram node: who does the step (§10.1). */
export type Kind =
  | "human"
  | "humanOrScout"
  | "llm"
  | "agent"
  | "workspace"
  | "auto"
  | "scout"
  | "checks";

const KIND_LABEL: Record<Kind, string> = {
  human: "Human",
  humanOrScout: "Human or scout",
  llm: "LLM call",
  agent: "Agent",
  workspace: "Workspace agent",
  auto: "Auto-merge",
  scout: "Scout",
  checks: "CI checks",
};

export function Badge({ kind }: { kind: Kind }) {
  return (
    <span
      className={cn(
        "absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border bg-card px-1.5 font-mono text-[9.5px] leading-4 whitespace-nowrap",
        kind === "human" || kind === "scout" || kind === "humanOrScout"
          ? "border-foreground/40 text-foreground"
          : kind === "auto"
            ? "border-primary/50 text-primary"
            : "border-border text-muted-foreground",
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
