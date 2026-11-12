import type { ItemOf } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ClipboardList,
  Info,
  ListTodo,
  Loader2,
  OctagonX,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { cn } from "@/lib/utils";
import { Markdown } from "../markdown";

/** A proposed plan, clipped when long, with copy and expand. */
export function PlanCard({ item }: { item: ItemOf<"plan"> }) {
  const [expanded, setExpanded] = useState(false);
  const long = item.text.length > 700;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <ClipboardList className="size-4 text-primary" />
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
          Plan
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-muted-foreground"
          onClick={() => void copyWithFeedback(item.text, "Plan copied")}
        >
          Copy
        </Button>
      </div>
      <div className={cn("relative px-4 py-3", long && !expanded && "max-h-64 overflow-hidden")}>
        <Markdown streaming={item.status === "in_progress"}>{item.text}</Markdown>
        {long && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-border py-1.5 text-2xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Collapse plan" : "Expand plan"}
        </button>
      )}
    </div>
  );
}

/** The agent's todo list with progress. */
export function TodoCard({ item }: { item: ItemOf<"todo_list"> }) {
  const done = item.todos.filter((t) => t.status === "completed").length;
  const pct = item.todos.length ? (done / item.todos.length) * 100 : 0;
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <ListTodo className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">Todos</span>
        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
          {done}/{item.todos.length} done
        </span>
      </div>
      <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-status-done transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="space-y-1">
        {item.todos.map((t, i) => (
          <li key={t.id ?? i} className="flex items-start gap-2 text-[13px]">
            {t.status === "completed" ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-status-done" />
            ) : t.status === "in_progress" ? (
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-status-running" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                "min-w-0 wrap-break-word",
                t.status === "completed" &&
                  "text-muted-foreground line-through decoration-muted-foreground/40",
              )}
            >
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Typed notices render as slim, quiet rows. */
export function NoticeCard({ item }: { item: ItemOf<"notice"> }) {
  const warn = item.level === "warning";
  const Icon = warn ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-2xs",
        warn
          ? "border-status-waiting/25 bg-status-waiting/[0.06] text-status-waiting"
          : "border-border/70 bg-muted/30 text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{item.message}</span>
      {item.code && (
        <span className="ml-auto shrink-0 font-mono text-3xs opacity-60">{item.code}</span>
      )}
    </div>
  );
}

/** Inline error with a retry when the provider says it may succeed. */
export function ErrorCard({ item, sessionId }: { item: ItemOf<"error">; sessionId: string }) {
  const client = useClient();
  const retry = useMutation({
    mutationFn: () =>
      client.sendMessage(sessionId, { text: "Please retry the last step." }, "send"),
  });
  return (
    <div className="rounded-xl border border-status-failed/30 bg-status-failed/[0.06] px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <OctagonX className="mt-0.5 size-4 shrink-0 text-status-failed" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{item.error.message}</p>
          {item.error.detail && (
            <pre className="mt-1.5 font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
              {item.error.detail}
            </pre>
          )}
        </div>
        {item.error.retryable && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            <RotateCcw /> Retry
          </Button>
        )}
      </div>
    </div>
  );
}
