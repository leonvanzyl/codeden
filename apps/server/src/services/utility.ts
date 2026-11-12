import {
  type FollowupSuggestion,
  READ_ALOUD_FULL_MAX_CHARS,
  READ_ALOUD_SUMMARY_MAX_CHARS,
  type Session,
  type Settings,
  type SpeechSummaryResponse,
  speechExcerpt,
} from "@codeden/contracts";
import type { RunnerPort } from "./runner-port";

/** Context handed to utility jobs about a finished turn. */
export interface TurnContext {
  session: Session;
  /** The turn's final assistant message, if any. */
  finalMessage: string | null;
  /** The first user message of the session, when known. */
  firstMessage?: string | null;
  /** Files the turn changed, when known. */
  changedFiles?: string[];
}

/**
 * Small side jobs on the utility model (§7.4): session titles, follow-up suggestions when the
 * agent did not call `suggest_followups` (§7.5), and read-aloud summaries (§11.3). Jobs return
 * null for "nothing to add" and never throw: a failing side job must not break a session.
 */
export interface UtilityService {
  sessionTitle(ctx: TurnContext): Promise<string | null>;
  suggestFollowups(ctx: TurnContext): Promise<FollowupSuggestion[] | null>;
  /**
   * What read-aloud speaks for a final message (§11.3), following `voice.readAloud.content`:
   * a TL;DR of at most two short sentences, or the whole cleaned message. Never long in
   * summary mode: without a model answer it is the message's first sentence or two.
   */
  speechSummary(text: string): Promise<SpeechSummaryResponse>;
  /**
   * A one-shot answer from the utility model for a server-side job, such as the software
   * factory's "Identify type" step; null when no model answered.
   */
  complete(job: string, system: string, prompt: string): Promise<string | null>;
}

/** A `UtilityService` that never calls a model (tests, no providers). */
export class NoopUtilityService implements UtilityService {
  async sessionTitle(): Promise<string | null> {
    return null;
  }
  async suggestFollowups(): Promise<FollowupSuggestion[] | null> {
    return null;
  }
  async speechSummary(text: string): Promise<SpeechSummaryResponse> {
    return { text: shortSpeech(plainSpeech(text)), source: "plain" };
  }
  async complete(): Promise<string | null> {
    return null;
  }
}

/** The summary-mode fallback: the first sentence or two, within the TL;DR cap. */
export function shortSpeech(plain: string): string {
  return speechExcerpt(plain, READ_ALOUD_SUMMARY_MAX_CHARS, 2);
}

/** Strip code blocks and markdown so text reads naturally aloud (§11.3). */
export function plainSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Utility-model calls through the runner (`provider.oneShot`), so the server spawns nothing. */
export interface OneShotPort {
  oneShot(
    providerId: string,
    req: { prompt: string; system?: string; model?: string; timeoutMs?: number },
  ): Promise<string>;
  /** Providers that can run one-shots, in preference order. */
  available(): string[];
}

export function runnerOneShot(runner: RunnerPort): OneShotPort {
  return {
    oneShot: async (providerId, req) =>
      (
        await runner.request(
          { name: "provider.oneShot", providerId, ...req },
          (req.timeoutMs ?? 60_000) + 5_000,
        )
      ).text,
    available: () => runner.providers().map((p) => p.id),
  };
}

const PREFERENCE = ["claude", "codex", "opencode"];
const TIMEOUT_MS = 60_000;
/** Read-aloud waits on the summary, so it gets less time than the other jobs. */
const SPEECH_TIMEOUT_MS = 30_000;

const TLDR_SYSTEM = [
  "You write the spoken TL;DR of a coding agent's final message. It is read aloud by a text-to-speech voice, so the listener cannot skim.",
  "Reply with at most two short sentences, under 200 characters in total.",
  "Say what was done and whether anything needs the user (a decision, a review, a failure). If nothing needs them, don't mention it.",
  "Plain spoken English only: no markdown, code, file paths, lists, numbers of lines or preamble such as 'Summary:'.",
].join(" ");

/** Server-side warnings for utility jobs, shown whatever the debug setting (stderr). */
function defaultWarn(message: string): void {
  console.warn(`[codeden] ${new Date().toISOString()} ${message}`);
}

/**
 * The real `UtilityService`: a one-shot, tool-less call on a small model (§7.4). The provider
 * comes from settings (`auto` = Claude, then Codex, then OpenCode); when the chosen provider
 * fails, the others are tried. Each job can be switched off in settings.
 */
export class ProviderUtilityService implements UtilityService {
  constructor(
    private readonly deps: {
      settings: () => Settings;
      oneShot: OneShotPort;
      /** Utility failures: always visible (the server log), since they change what users get. */
      warn?: (message: string) => void;
    },
  ) {}

  /** Set while no provider can run one-shots, so that is reported once, not on every job. */
  private reportedNoProvider = false;

  private warn(message: string): void {
    (this.deps.warn ?? defaultWarn)(message);
  }

  async sessionTitle(ctx: TurnContext): Promise<string | null> {
    if (!this.deps.settings().utilityModel.jobs.sessionTitles) return null;
    const source = ctx.firstMessage ?? ctx.finalMessage;
    if (!source) return null;
    const out = await this.run(
      "session title",
      "Write a title of 3 to 6 words for a coding session that starts with the request below. Reply with the title only: no quotes, no trailing punctuation.",
      `Request:\n${clip(source, 4_000)}`,
    );
    const title = out
      ?.split("\n")[0]
      ?.replace(/^["'#\s]+|["'.\s]+$/g, "")
      .slice(0, 80);
    return title ? title : null;
  }

  async suggestFollowups(ctx: TurnContext): Promise<FollowupSuggestion[] | null> {
    if (!this.deps.settings().utilityModel.jobs.followups || !ctx.finalMessage) return null;
    const files = ctx.changedFiles?.length ? `\nFiles changed: ${ctx.changedFiles.join(", ")}` : "";
    const out = await this.run(
      "follow-ups",
      "You suggest what a developer might ask a coding agent next. Reply with 2 to 4 short prompts, one per line, written as the developer would type them. No numbering, no quotes, nothing else.",
      `The agent's final message:\n${clip(ctx.finalMessage, 6_000)}${files}`,
    );
    const lines = (out ?? "")
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:[-*\d.)]+\s*)?/, "")
          .replace(/^["']|["']$/g, "")
          .trim(),
      )
      .filter((l) => l.length > 0 && l.length <= 300)
      .slice(0, 4);
    return lines.length >= 2 ? lines.map((prompt) => ({ prompt })) : null;
  }

  async speechSummary(text: string): Promise<SpeechSummaryResponse> {
    const plain = plainSpeech(text);
    if (this.deps.settings().voice.readAloud.content === "full") {
      return { text: speechExcerpt(plain, READ_ALOUD_FULL_MAX_CHARS), source: "plain" };
    }
    if (plain.length <= READ_ALOUD_SUMMARY_MAX_CHARS) return { text: plain, source: "plain" };
    const out = await this.run("read-aloud TL;DR", TLDR_SYSTEM, clip(plain, 12_000), {
      timeoutMs: SPEECH_TIMEOUT_MS,
    });
    const tldr = out ? plainSpeech(out) : "";
    if (tldr) return { text: shortSpeech(tldr), source: "utility" };
    this.warn("utility: read-aloud TL;DR unavailable, speaking the message's first sentences");
    return { text: shortSpeech(plain), source: "plain" };
  }

  complete(job: string, system: string, prompt: string): Promise<string | null> {
    return this.run(job, system, prompt);
  }

  /** One-shot on the configured provider, falling back to the next; null on failure. */
  private async run(
    job: string,
    system: string,
    prompt: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<string | null> {
    const { utilityModel } = this.deps.settings();
    const available = this.deps.oneShot.available();
    const chosen = utilityModel.provider === "auto" ? null : utilityModel.provider;
    const order = [chosen, ...PREFERENCE].filter(
      (id, i, all): id is string => !!id && available.includes(id) && all.indexOf(id) === i,
    );
    if (order.length === 0) {
      if (!this.reportedNoProvider) {
        this.warn(
          `utility: no provider can run the utility model (runner lists: ${available.join(", ") || "none"})`,
        );
      }
      this.reportedNoProvider = true;
      return null;
    }
    this.reportedNoProvider = false;
    for (const providerId of order) {
      try {
        const model = providerId === chosen ? (utilityModel.model ?? undefined) : undefined;
        const text = await this.deps.oneShot.oneShot(providerId, {
          prompt,
          system,
          model,
          timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
        });
        if (text.trim()) return text.trim();
        this.warn(`utility: ${job} on ${providerId} returned nothing`);
      } catch (error) {
        this.warn(
          `utility: ${job} on ${providerId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
