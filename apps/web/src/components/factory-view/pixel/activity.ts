import type { Item } from "@codeden/contracts";
import { redactSecrets } from "@/lib/redact";

/**
 * What an agent is doing right now (#264): the thought bubble above its head. Each new item in
 * its live transcript becomes a short activity: the tool call's title ("Edit
 * src/factory/queue.ts", "Run pnpm test", "Read DESIGN.md", "Search: withReviewer"), or, when no
 * tool call ran lately, a snippet of its latest reasoning or reply. Only titles are used: a
 * command shows its program and subcommand, never its arguments, and every text goes through
 * `redactSecrets`, so the scene can't leak a token. One bubble per agent, changing at most every
 * two seconds and fading a few seconds after it appeared. Pure, so it's unit-tested.
 */

export type ActivityKind = "edit" | "run" | "read" | "search" | "web" | "think";

export interface Activity {
  /** The transcript item it comes from; a later update of the same item replaces it. */
  itemId: string;
  kind: ActivityKind;
  text: string;
}

/** Bubble text is cut to about this many characters, with an ellipsis. */
export const BUBBLE_CHARS = 40;
/** A bubble changes at most this often, so busy agents don't flicker. */
export const BUBBLE_MIN_MS = 2000;
/** How long a bubble stays after it appeared (its last second fades). */
export const BUBBLE_SHOW_MS = 5000;
/** For this long after a tool call, reasoning and replies don't replace its bubble. */
export const TOOL_RECENT_MS = 8000;
/** Activities a hovered agent's card lists. */
export const HISTORY = 3;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Cut to `max` characters with an ellipsis; paths keep their end ("…/factory/queue.ts"). */
export function cut(text: string, max = BUBBLE_CHARS, keepEnd = false): string {
  if (text.length <= max) return text;
  return keepEnd ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Words that set up a command rather than name it. */
const SETUP = new Set(["cd", "export", "set", "env", "sudo", "time", "nohup"]);
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * A command named by its program and, when it is a plain word, its subcommand: "pnpm test",
 * "git status", "npx vitest". Environment assignments, flags, paths, quotes and every other
 * argument are left out, so nothing the agent typed after them can show.
 */
export function safeCommand(command: string): string {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part
      .trim()
      .split(/\s+/)
      .filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0];
    if (!first || SETUP.has(first)) continue;
    const program = first.split(/[\\/]/).pop() ?? first;
    if (!PLAIN.test(program)) return "a command";
    const sub = words[1];
    return sub && PLAIN.test(sub) && !sub.startsWith("-") && sub.length <= 24
      ? `${program} ${sub}`
      : program;
  }
  return "a command";
}

/** A path or other target, trimmed, redacted and cut from the front. */
const target = (s: string) => cut(redactSecrets(squash(s)), BUBBLE_CHARS - 6, true);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The bubble for a transcript item; null for items that aren't the agent's own doing. */
export function activityOf(item: Item): Activity | null {
  const make = (kind: ActivityKind, text: string): Activity => ({
    itemId: item.id,
    kind,
    text: cut(redactSecrets(squash(text))),
  });
  if (item.kind === "reasoning") {
    const text = item.summary ?? (item.redacted ? "" : item.text);
    return text.trim() ? make("think", text) : make("think", "Thinking…");
  }
  if (item.kind === "assistant_message") return item.text.trim() ? make("think", item.text) : null;
  if (item.kind !== "tool_call") return null;
  switch (item.toolKind) {
    case "command":
      return make("run", `Run ${safeCommand(item.command)}`);
    case "file_edit": {
      const one = item.changes.length === 1 ? item.changes[0]?.path : undefined;
      return make("edit", one ? `Edit ${target(one)}` : `Edit ${item.changes.length} files`);
    }
    case "file_read":
      return make("read", `Read ${target(item.path)}`);
    case "search":
      return make("search", `Search: ${item.query}`);
    case "web":
      return make(
        "web",
        item.title ?? (item.url ? `Web: ${hostOf(item.url)}` : `Web: ${item.query ?? ""}`),
      );
    case "browser":
      return make("web", item.title ?? `Browser: ${item.action}`);
    case "mcp":
      return make("run", item.title ?? `${item.server} · ${item.tool}`);
    default:
      return make("run", item.title ?? item.toolName);
  }
}

/** An agent's bubble and recent activities. */
export interface AgentActivity {
  /** The bubble now, and since when it shows. */
  shown: Activity | null;
  shownAt: number;
  /** The next bubble, held back until `BUBBLE_MIN_MS` has passed. */
  pending: Activity | null;
  /** When it last ran a tool. */
  toolAt: number;
  /** The latest activities, newest first. */
  history: Activity[];
}

export const NO_ACTIVITY: AgentActivity = {
  shown: null,
  shownAt: Number.NEGATIVE_INFINITY,
  pending: null,
  toolAt: Number.NEGATIVE_INFINITY,
  history: [],
};

const same = (a: Activity | null, b: Activity) => a?.itemId === b.itemId && a.text === b.text;

/** Takes in a new activity at `now`. Returns the same state when nothing changes. */
export function noteActivity(s: AgentActivity, a: Activity, now: number): AgentActivity {
  if (same(s.history[0] ?? null, a) || same(s.pending, a)) return s;
  const isTool = a.kind !== "think";
  // A reply or reasoning doesn't push a recent tool call's bubble away.
  if (!isTool && now - s.toolAt < TOOL_RECENT_MS && s.history[0]?.itemId !== a.itemId) return s;
  const history = [a, ...s.history.filter((h) => h.itemId !== a.itemId)].slice(0, HISTORY);
  const next = { ...s, history, toolAt: isTool ? now : s.toolAt };
  if (now - s.shownAt >= BUBBLE_MIN_MS) return { ...next, shown: a, shownAt: now, pending: null };
  if (s.shown?.itemId === a.itemId) return { ...next, shown: a };
  return { ...next, pending: a };
}

/** Shows a held-back bubble once its turn comes. */
export function tickActivity(s: AgentActivity, now: number): AgentActivity {
  if (!s.pending || now - s.shownAt < BUBBLE_MIN_MS) return s;
  return { ...s, shown: s.pending, shownAt: now, pending: null };
}

/** The last part of a bubble's life, when it fades out. */
export const FADE_MS = 1000;

/**
 * The bubble to show at `now`, and whether it is fading (its last second); null once it has
 * gone. A pinned bubble (its agent is hovered) stays, showing the latest activity.
 */
export function bubbleOf(
  s: AgentActivity,
  now: number,
  pinned = false,
): { activity: Activity; fading: boolean } | null {
  const latest = s.shown ?? s.history[0] ?? null;
  if (pinned) return latest ? { activity: latest, fading: false } : null;
  if (!s.shown) return null;
  const left = BUBBLE_SHOW_MS - (now - s.shownAt);
  if (left <= 0) return null;
  return { activity: s.shown, fading: left <= FADE_MS };
}

/**
 * When the bubble next changes on its own: a held-back one shows, the shown one starts to fade,
 * or it goes. Null when nothing will change without a new activity.
 */
export function nextChange(s: AgentActivity, now: number): number | null {
  if (s.pending) return Math.max(now, s.shownAt + BUBBLE_MIN_MS);
  if (!s.shown) return null;
  const fade = s.shownAt + BUBBLE_SHOW_MS - FADE_MS;
  const end = s.shownAt + BUBBLE_SHOW_MS;
  if (now < fade) return fade;
  return now < end ? end : null;
}
