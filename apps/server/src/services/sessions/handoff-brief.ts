import type { Item, ItemOf, Session, Turn, UserInput } from "@codeden/contracts";
import type { FileEditCall } from "./repo";

/** The whole brief stays within this many characters (§9). */
export const BRIEF_MAX = 16_000;
const TASK_MAX = 4_000;
const REQUEST_MAX = 600;
const REQUESTS_SHOWN = 10;
const PROGRESS_MAX = 4_000;
const RESULT_MAX = 1_500;
const TODO_MAX = 200;
const TODOS_SHOWN = 20;
const ERROR_MAX = 500;
const FILES_SHOWN = 50;
/** The compact transcript the utility model summarises (§7.4). */
export const TRANSCRIPT_MAX = 24_000;

/** What a handoff's brief is written from: the source session and its transcript. */
export interface HandoffSource {
  session: Session;
  /** Display name of the source's provider. */
  providerName: string;
  /** Whether the new worktree gets the source's uncommitted changes (it had a checkpoint). */
  restored: boolean;
  /** The source's root-thread user messages, oldest first. */
  requests: ItemOf<"user_message">[];
  /** Its latest root-thread assistant message, if any. */
  lastReply: string | null;
  /** Its latest root-thread todo list, if any. */
  todos: ItemOf<"todo_list"> | null;
  /** Its last root turn. */
  lastTurn: Turn | null;
  /** Every file edit of the session, oldest first. */
  edits: FileEditCall[];
  /** The utility model's summary of the work (§7.4); null without one. */
  summary: string | null;
  /** What the user wants done next. */
  note?: string;
}

/**
 * The first message of a handoff (§9): what the new session needs to carry on without the
 * source's conversation. Sections in order: who it takes over from and where the code is, the
 * task, later requests, where the work got to, the files edited, and what to do next. The
 * intro and the closing are always whole; the sections between are shortened when the brief
 * would pass `BRIEF_MAX`.
 */
export function buildHandoffBrief(src: HandoffSource): string {
  const head = intro(src);
  const tail = closing(src);
  const body = [task(src), laterRequests(src), progress(src), files(src)]
    .filter((s): s is string => s !== null)
    .join("\n\n");
  const room = BRIEF_MAX - head.length - tail.length - 4;
  const fitted =
    body.length <= room ? body : `${body.slice(0, Math.max(0, room - 30))}\n\n…(brief shortened)`;
  return [head, fitted, tail].filter(Boolean).join("\n\n");
}

function intro(src: HandoffSource): string {
  const { session: s, providerName } = src;
  const title = s.title ?? s.purpose;
  const model = s.model ? ` · ${s.model}` : "";
  const changes = src.restored ? ", with the uncommitted changes it had restored" : "";
  const folder = s.worktreePath
    ? ` (\`${s.worktreePath}\`; paths there mean the same files here)`
    : "";
  const lines = [
    `You are taking over a coding task from another CodeDen session, "${oneLine(title)}" (${providerName}${model}). You don't have its conversation: this brief is what it did.`,
    s.branch
      ? `Its code is already in this worktree: your branch starts from its branch \`${s.branch}\`${changes}. Work here only, not in its folder${folder}.`
      : "",
    s.issue
      ? `Issue: #${s.issue.number}${s.issue.title ? ` ${oneLine(s.issue.title)}` : ""} (${s.issue.url})`
      : "",
    s.pr ? `Its pull request: #${s.pr.number} (${s.pr.url}). Yours will be a new one.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function task(src: HandoffSource): string {
  const first = src.requests[0];
  const text = first ? message(first.input, TASK_MAX) : clip(src.session.purpose, TASK_MAX);
  return `## The task\n\n${text}`;
}

/** Later messages to the source, CodeDen's own (retries, wake-ups, PR feedback) left out. */
function laterRequests(src: HandoffSource): string | null {
  const later = src.requests.slice(1).filter((m) => m.input.from !== "codeden");
  if (later.length === 0) return null;
  const shown = later.slice(-REQUESTS_SHOWN);
  const omitted = later.length - shown.length;
  const heading =
    omitted > 0 ? `## Later requests (${omitted} earlier left out)` : "## Later requests";
  const lines = shown.map((m) => `- ${indent(message(m.input, REQUEST_MAX))}`);
  return [heading, "", ...lines].join("\n");
}

function progress(src: HandoffSource): string {
  const parts: string[] = [];
  if (src.summary?.trim()) parts.push(clip(src.summary.trim(), PROGRESS_MAX));
  else if (src.lastReply?.trim()) {
    parts.push(`Its last reply:\n\n${quote(clip(src.lastReply.trim(), PROGRESS_MAX))}`);
  } else parts.push("It didn't reply yet.");
  const result = src.session.result;
  if (result) {
    parts.push(
      `Its recorded result: **${result.outcome}**. ${clip(oneLine(result.summary), RESULT_MAX)}`,
    );
  }
  const open = (src.todos?.todos ?? []).filter((t) => t.status !== "completed");
  if (open.length > 0) {
    const shown = open.slice(0, TODOS_SHOWN).map((t) => {
      const mark = t.status === "in_progress" ? " (in progress)" : "";
      return `- ${clip(oneLine(t.text), TODO_MAX)}${mark}`;
    });
    if (open.length > shown.length) shown.push(`- and ${open.length - shown.length} more`);
    parts.push(["Still open on its todo list:", ...shown].join("\n"));
  }
  const turn = src.lastTurn;
  if (turn && (turn.status === "failed" || turn.status === "interrupted")) {
    const why = turn.error?.message ? `: ${clip(oneLine(turn.error.message), ERROR_MAX)}` : ".";
    parts.push(`Its last turn ${turn.status === "failed" ? "failed" : "was interrupted"}${why}`);
  }
  return `## Where it got to\n\n${parts.join("\n\n")}`;
}

function files(src: HandoffSource): string | null {
  const paths = editedPaths(src.edits, src.session.worktreePath ?? src.session.cwd);
  if (paths.length === 0) return null;
  const shown = paths.slice(0, FILES_SHOWN).map((p) => `- ${p}`);
  if (paths.length > FILES_SHOWN) shown.push(`- and ${paths.length - FILES_SHOWN} more`);
  return ["## Files it edited", "", ...shown].join("\n");
}

function closing(src: HandoffSource): string {
  const base = src.session.baseBranch ?? "the base branch";
  const next = src.note?.trim()
    ? `## What to do next (from the user)\n\n${src.note.trim()}`
    : "## What to do next\n\nContinue the work where it left off.";
  return `${next}\n\nCheck the code's current state (\`git status\`, \`git diff ${base}\`) before relying on this brief.`;
}

/**
 * The paths the session edited, each once in the order first edited, relative to its worktree
 * when inside it (the new session's worktree holds the same files at the same relative paths).
 */
export function editedPaths(edits: FileEditCall[], root: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const edit of edits) {
    for (const change of edit.changes) {
      const path = relativeTo(change.path, root);
      if (path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

function relativeTo(path: string, root: string | null): string {
  const p = path.replace(/\\/g, "/");
  if (!root) return p;
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[a-z]:\//i.test(r);
  const inside = windows
    ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`)
    : p.startsWith(`${r}/`);
  return inside ? p.slice(r.length + 1) : p;
}

/**
 * The source's root thread as short lines for the utility model to summarise: messages, commands,
 * edits and other tool calls, newest kept within `TRANSCRIPT_MAX`. The task (`task`, the first
 * user message, read on its own because `items` may be only the newest ones) always leads.
 */
export function handoffTranscript(
  items: Item[],
  root: string | null,
  task?: ItemOf<"user_message">,
): string {
  const first = task ?? items.find((i): i is ItemOf<"user_message"> => i.kind === "user_message");
  const head = first ? userLine(first.input) : null;
  const lines = items
    .filter((item) => item.id !== first?.id)
    .flatMap((item) => transcriptLine(item, root));
  const kept: string[] = [];
  let size = head ? head.length + 1 : 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (size + line.length + 1 > TRANSCRIPT_MAX) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return (head ? [head, ...kept] : kept).join("\n");
}

const userLine = (input: UserInput) => `User: ${clip(oneLine(input.text), 1_500)}`;

function transcriptLine(item: Item, root: string | null): string[] {
  switch (item.kind) {
    case "user_message":
      return item.input.from === "codeden" ? [] : [userLine(item.input)];
    case "assistant_message":
      return item.text.trim() ? [`Agent: ${clip(oneLine(item.text), 2_000)}`] : [];
    case "tool_call":
      if (item.toolKind === "command") return [`$ ${clip(oneLine(item.command), 200)}`];
      if (item.toolKind === "file_edit") {
        return [`Edited: ${editedPaths([item], root).join(", ")}`];
      }
      return [`Tool: ${clip(oneLine(item.title ?? item.toolName), 200)}`];
    default:
      return [];
  }
}

/** A message's text, clipped, noting attachments that aren't carried over. */
function message(input: UserInput, max: number): string {
  const text = clip(input.text.trim(), max) || "(no text)";
  const n = input.attachments.length;
  return n > 0 ? `${text}\n(${n} attachment${n === 1 ? "" : "s"} not included here)` : text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function indent(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}
