import type { FactoryTuning } from "@codeden/contracts";
import { earliestUntil, type Unavailable, unavailableText, untilText } from "./availability";

/**
 * Which provider and model run a review (§10.1, Review). Pure: the caller passes the providers
 * available now and why the others aren't.
 */

/** Providers tried for reviews, in order, when the author's provider is excluded. */
const REVIEW_ORDER = ["codex", "claude"];

export interface ReviewerChoice {
  wait: false;
  provider: string;
  /** Null: the provider's default model. */
  model: string | null;
  /** True when the reviewer runs on a different provider from the author. */
  crossProvider: boolean;
  /** Why the review doesn't run where the settings ask (fallback, same provider). */
  note: string | null;
}

/** No provider the settings allow is available: the review waits, with the item note. */
export interface ReviewerWait {
  wait: true;
  note: string;
}

export interface ReviewerInput {
  /** The builder's provider and model (null when not known). */
  author: { provider: string | null; model: string | null };
  tuning: Pick<FactoryTuning, "reviewerProvider" | "reviewerModel" | "reviewerFallback">;
  /** Providers that can take new work now. */
  available: readonly string[];
  /** Providers the runner offers that can't, and why. */
  unavailable: ReadonlyArray<{ provider: string } & Unavailable>;
  /** A provider's name for notes. */
  name?: (id: string) => string;
}

/**
 * The configured reviewer when it is available. With `auto`, a provider other than the
 * author's (Codex reviews Claude's work and vice versa), and the author's own only when no
 * other provider is installed at all. When the wanted provider is unavailable, the
 * `reviewerFallback` decides: the builder's provider and model, any available provider, or
 * waiting. With nothing available at all, the review waits.
 */
export function pickReviewer(input: ReviewerInput): ReviewerChoice | ReviewerWait {
  const { author, tuning, available } = input;
  const name = input.name ?? ((id: string) => id);
  if (available.length === 0) {
    const until = earliestUntil(input.unavailable);
    return { wait: true, note: `Waiting: no review provider available${untilText(until)}` };
  }
  let wanted: string;
  if (tuning.reviewerProvider !== "auto") {
    wanted = tuning.reviewerProvider;
    if (available.includes(wanted)) {
      return {
        wait: false,
        provider: wanted,
        model: tuning.reviewerModel,
        crossProvider: wanted !== author.provider,
        note: null,
      };
    }
  } else {
    const others = available.filter((p) => p !== author.provider);
    const preferred = [...REVIEW_ORDER, ...others].find((p) => others.includes(p));
    if (preferred) {
      return { wait: false, provider: preferred, model: null, crossProvider: true, note: null };
    }
    const blocked = input.unavailable.find((u) => u.provider !== author.provider);
    if (!blocked) {
      // Only one provider at all: the review runs on the author's, as it always has.
      const same =
        author.provider && available.includes(author.provider) ? author.provider : available[0];
      return {
        wait: false,
        provider: same as string,
        model: same === author.provider ? author.model : null,
        crossProvider: false,
        note: `No provider other than ${name(same as string)} is available; the review ran on the same provider as the author.`,
      };
    }
    wanted = blocked.provider;
  }
  const why = input.unavailable.find((u) => u.provider === wanted) ?? {
    reason: "not available",
    until: null,
  };
  return fallback(input, unavailableText(name(wanted), why), name);
}

function fallback(
  input: ReviewerInput,
  reason: string,
  name: (id: string) => string,
): ReviewerChoice | ReviewerWait {
  const { author, available } = input;
  const mode = input.tuning.reviewerFallback;
  if (mode === "wait") return { wait: true, note: `Waiting: ${reason}` };
  if (mode === "builder" && author.provider && available.includes(author.provider)) {
    return {
      wait: false,
      provider: author.provider,
      model: author.model,
      crossProvider: false,
      note: `${reason}; the review ran on the builder's provider (${name(author.provider)}) in a fresh session.`,
    };
  }
  // `any`, or the builder's provider is unavailable too.
  const other =
    [...REVIEW_ORDER, ...available].find((p) => available.includes(p) && p !== author.provider) ??
    (available[0] as string);
  return {
    wait: false,
    provider: other,
    model: other === author.provider ? author.model : null,
    crossProvider: other !== author.provider,
    note: `${reason}; the review ran on ${name(other)}.`,
  };
}
