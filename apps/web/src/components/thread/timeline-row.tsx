import { CircleSlash, OctagonX } from "lucide-react";
import { useEffect, useState } from "react";
import { useTurnCostText } from "@/components/usage/session-cost";
import { duration, plural } from "@/lib/format";
import type { TimelineRow as Row } from "@/lib/transcript/timeline";
import { ApprovalCard } from "./cards/approval-card";
import { NoticeBatchCard, noticeBatchOf } from "./cards/notice-cards";
import { QuestionCard } from "./cards/question-card";
import { SharedArtifactCard, sharedArtifactOf } from "./cards/shared-artifact-card";
import { ErrorCard, NoticeCard, PlanCard, TodoCard } from "./cards/simple-cards";
import { SubagentCard } from "./cards/subagent-card";
import { ForkFromHere } from "./fork-from-here";
import { AssistantMessage, UserMessage } from "./messages";
import { WorkGroup } from "./work/work-group";

function Working({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 px-1.5 text-2xs text-muted-foreground">
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1 animate-pulse rounded-full bg-status-running"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      <span className="text-shine">Working</span>
      <span className="tabular-nums">{duration(Math.max(0, now - Date.parse(startedAt)))}</span>
    </div>
  );
}

function TurnFooter({
  row,
  sessionId,
}: {
  row: Extract<Row, { type: "turn-end" }>;
  sessionId: string;
}) {
  const { turn } = row;
  const cost = useTurnCostText(sessionId, turn.id);
  const parts: string[] = [];
  if (row.durationMs !== null && row.durationMs > 0)
    parts.push(`Worked for ${duration(row.durationMs)}`);
  if (row.filesChanged > 0) parts.push(`${plural(row.filesChanged, "file")} changed`);
  if (cost) parts.push(cost);
  return (
    <div className="group relative flex items-center gap-3 py-1 text-3xs text-muted-foreground/70">
      <div className="h-px flex-1 bg-border/70" />
      {turn.status === "failed" ? (
        <span className="flex items-center gap-1 text-status-failed">
          <OctagonX className="size-3" /> Turn failed{turn.error ? ` · ${turn.error.message}` : ""}
        </span>
      ) : turn.status === "interrupted" ? (
        <span className="flex items-center gap-1">
          <CircleSlash className="size-3" /> Interrupted
        </span>
      ) : (
        <span>{parts.join(" · ") || "Done"}</span>
      )}
      <div className="h-px flex-1 bg-border/70" />
      <ForkFromHere sessionId={sessionId} row={row} />
    </div>
  );
}

/** Render one timeline row. */
export function TimelineRowView({ row, sessionId }: { row: Row; sessionId: string }) {
  switch (row.type) {
    case "user":
      return <UserMessage item={row.item} />;
    case "assistant":
      return <AssistantMessage item={row.item} streaming={row.streaming} />;
    case "work":
      return <WorkGroup entries={row.entries} live={row.live} />;
    case "working":
      return <Working startedAt={row.turn.startedAt} />;
    case "turn-end":
      return <TurnFooter row={row} sessionId={sessionId} />;
    case "card": {
      const item = row.item;
      switch (item.kind) {
        case "approval_request":
          return <ApprovalCard item={item} sessionId={sessionId} />;
        case "user_question":
          return <QuestionCard item={item} sessionId={sessionId} />;
        case "subagent":
          return <SubagentCard item={item} sessionId={sessionId} />;
        case "plan":
          return <PlanCard item={item} />;
        case "todo_list":
          return <TodoCard item={item} />;
        case "notice": {
          const artifact = sharedArtifactOf(item);
          if (artifact) return <SharedArtifactCard item={item} artifact={artifact} />;
          const notices = noticeBatchOf(item);
          if (notices) return <NoticeBatchCard notices={notices} />;
          return <NoticeCard item={item} />;
        }
        case "error":
          return <ErrorCard item={item} sessionId={sessionId} />;
        default:
          return null;
      }
    }
  }
}
