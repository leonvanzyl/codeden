import {
  answerFormatName,
  type ItemOf,
  type ItemStatus,
  parseNumberAnswer,
  type RuntimeResponse,
  type UserQuestion,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, MessageCircleQuestion, Minus, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

type Answers = Record<string, string[]>;

/**
 * Structured questions from the agent, answered inline with options and optional free text. An
 * MCP server's form (`mcpServer`) can also be dismissed, so the user never has to make up data;
 * its number fields (`format`) are checked as they are typed, so the server gets what it asked
 * for. A form that was dismissed or declined says so instead of looking answered.
 */
export function QuestionCard({
  item,
  sessionId,
}: {
  item: ItemOf<"user_question">;
  sessionId: string;
}) {
  const client = useClient();
  const errorId = useId();
  const [answers, setAnswers] = useState<Answers>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const pending = item.status === "in_progress";
  const submit = useMutation({
    mutationFn: (response: RuntimeResponse) => client.respond(sessionId, item.requestId, response),
    onError: (e) => toast.error("Couldn't send your answer", { description: e.message }),
  });

  if (!pending) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-card/50 px-3 py-2.5 text-[13px]">
        {item.questions.map((q) => (
          <AnsweredQuestion
            key={q.id}
            question={q}
            answers={item.answers?.[q.id] ?? []}
            status={item.status}
          />
        ))}
        {item.decidedBy === "pm" && (
          <p className="text-2xs text-muted-foreground">Answered by the project manager</p>
        )}
        {item.status === "cancelled" && (
          <p className="text-2xs text-muted-foreground">
            {item.mcpServer ? `Dismissed: nothing was sent to ${item.mcpServer}` : "Dismissed"}
          </p>
        )}
        {item.status === "declined" && (
          <p className="text-2xs text-muted-foreground">
            {item.mcpServer ? `Declined: ${item.mcpServer} got no data` : "Declined"}
          </p>
        )}
      </div>
    );
  }

  const toggle = (qid: string, label: string, multi: boolean) =>
    setAnswers((prev) => {
      const cur = prev[qid] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...prev, [qid]: next };
    });

  const final = (): Answers =>
    Object.fromEntries(
      item.questions.map((q) => {
        const text = freeText[q.id]?.trim();
        return [q.id, [...(answers[q.id] ?? []), ...(text ? [text] : [])]];
      }),
    );
  const complete = item.questions.every((q) => (final()[q.id]?.length ?? 0) > 0);
  /** What's wrong with a typed answer to a number field, while it doesn't fit. */
  const problem = (q: UserQuestion): string | undefined => {
    const text = freeText[q.id]?.trim();
    if (!q.format || !text || parseNumberAnswer(text, q.format) !== undefined) return undefined;
    return `Enter ${answerFormatName(q.format)}, like ${q.format === "integer" ? "3 or 1,000" : "2.5 or 1,000"}`;
  };
  const invalid = item.questions.some((q) => problem(q) !== undefined);

  return (
    <div className="overflow-hidden rounded-xl border border-chart-2/30 bg-card animate-rise">
      <div className="flex items-center gap-2 border-b border-chart-2/15 bg-chart-2/[0.07] px-3.5 py-2">
        <MessageCircleQuestion className="size-4 text-chart-2" />
        <span className="text-2xs font-semibold tracking-wider text-chart-2 uppercase">
          {item.questions.length > 1 ? `${item.questions.length} questions` : "Question"}
        </span>
      </div>
      <div className="divide-y divide-border">
        {item.questions.map((q, qi) => (
          <section key={q.id} className="min-w-0 space-y-2 px-3.5 py-3" aria-label={q.question}>
            {/* The header chip sits inline, so a long question wraps around it instead of squeezing it. */}
            <p className="mb-2 text-[14px] font-medium wrap-break-word">
              {q.header && (
                <span className="mr-2 inline-block max-w-full rounded bg-muted px-1.5 py-px text-3xs font-medium text-muted-foreground uppercase">
                  {q.header}
                </span>
              )}
              {q.question}
            </p>
            <div className="grid grid-cols-1 gap-1">
              {q.options.map((o, oi) => {
                const selected = answers[q.id]?.includes(o.label) ?? false;
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(q.id, o.label, q.multiSelect)}
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-0 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-chart-2/50 bg-chart-2/[0.08]"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                        q.multiSelect ? "rounded-[4px]" : "rounded-full",
                        selected ? "border-chart-2 bg-chart-2 text-background" : "border-input",
                      )}
                    >
                      {selected && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 wrap-break-word">
                      <span className="block text-[13px]">{o.label}</span>
                      {o.description && (
                        <span className="block text-2xs text-muted-foreground">
                          {o.description}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-3xs text-muted-foreground/60 tabular-nums">
                      {qi === 0 ? oi + 1 : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            {q.allowFreeText && (
              <Input
                placeholder={
                  q.format ? `Type ${answerFormatName(q.format)}…` : "Or type your own answer…"
                }
                value={freeText[q.id] ?? ""}
                onChange={(e) => setFreeText((p) => ({ ...p, [q.id]: e.target.value }))}
                aria-invalid={problem(q) !== undefined}
                aria-describedby={problem(q) ? `${errorId}-${qi}` : undefined}
                className="h-8 text-[13px]"
              />
            )}
            {problem(q) && (
              <p id={`${errorId}-${qi}`} className="text-2xs text-destructive">
                {problem(q)}
              </p>
            )}
          </section>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-3.5 py-2">
        <span className="mr-auto text-2xs text-muted-foreground">
          {item.mcpServer
            ? `Your answers go to ${item.mcpServer}. The agent waits until you answer or dismiss.`
            : "The agent is paused until you answer."}
        </span>
        {item.mcpServer && (
          <Button
            size="sm"
            variant="ghost"
            disabled={submit.isPending || submit.isSuccess}
            className="text-muted-foreground"
            onClick={() => submit.mutate({ kind: "cancel" })}
          >
            Dismiss
          </Button>
        )}
        <Button
          size="sm"
          disabled={!complete || invalid || submit.isPending || submit.isSuccess}
          onClick={() => submit.mutate({ kind: "answer", answers: final() })}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

/**
 * One answered question. A short answer stays on the question's line after an arrow; when the
 * two don't fit side by side the answer wraps onto its own line, lined up with the question.
 * Picked options are listed first, then any typed answer on its own line with its line breaks
 * kept. Long text is clamped to a few lines with a toggle to show it all. The check mark is for
 * answers that were sent; a declined or dismissed question gets a muted mark instead.
 */
function AnsweredQuestion({
  question,
  answers,
  status,
}: {
  question: UserQuestion;
  answers: string[];
  status: ItemStatus;
}) {
  const questionRef = useRef<HTMLParagraphElement>(null);
  const answerRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  // Measure while collapsed (and again on resize) whether either clamp hides any text.
  useLayoutEffect(() => {
    if (expanded) return;
    const elements = [questionRef.current, answerRef.current].filter((el) => el !== null);
    const measure = () => setClamped(elements.some((el) => el.scrollHeight > el.clientHeight + 1));
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  const isOption = (answer: string) => question.options.some((o) => o.label === answer);
  const picked = answers.filter(isOption);
  const typed = answers.filter((a) => !isOption(a));

  const Mark = status === "completed" ? Check : status === "declined" ? X : Minus;

  return (
    <div className="flex gap-2">
      <Mark
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          Mark === Check ? "text-status-done" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p
            ref={questionRef}
            className={cn(
              "min-w-0 wrap-break-word text-muted-foreground",
              !expanded && "line-clamp-3",
            )}
          >
            {question.question}
          </p>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
            <p
              ref={answerRef}
              className={cn(
                "min-w-0 font-medium whitespace-pre-wrap wrap-break-word",
                !expanded && "line-clamp-4",
              )}
            >
              {answers.length === 0 && "—"}
              {picked.map((answer, i) => (
                <span key={answer}>
                  {i > 0 && <span className="font-normal text-muted-foreground">, </span>}
                  {answer}
                </span>
              ))}
              {typed.map((answer, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: answers are fixed once given.
                <span key={i}>
                  {(picked.length > 0 || i > 0) && "\n"}
                  {answer}
                </span>
              ))}
            </p>
          </div>
        </div>
        {(clamped || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}
