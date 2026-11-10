import type { CostSource, ModelPrice, TokenCounts } from "@codeden/contracts";

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const AS_OF = "2026-11-10";

type Row = [
  model: string,
  label: string,
  input: number,
  output: number,
  read: number,
  write: number,
];

function table(provider: string, sourceUrl: string, rows: Row[]): ModelPrice[] {
  return rows.map(([model, label, input, output, read, write]) => ({
    provider,
    model,
    label,
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: read,
    cacheWritePerMTok: write,
    asOf: AS_OF,
    sourceUrl,
  }));
}

/**
 * Bundled list prices in USD per million tokens, checked on `AS_OF` against the providers'
 * pricing pages. Cache writes are the 5-minute rate for Claude; OpenAI charges none for the
 * models Codex runs. Haiku 5.5 uses its rate for prompts up to 100k tokens. Users can
 * override or add models in the usage settings.
 */
export const BUNDLED_PRICES: ModelPrice[] = [
  ...table("claude", ANTHROPIC, [
    ["claude-fable-5-2", "Fable 5.2", 8, 40, 0.2, 10],
    ["claude-fable-5-1", "Fable 5.1", 10, 50, 0.25, 12.5],
    ["claude-fable-5", "Fable 5", 10, 50, 1, 12.5],
    ["claude-opus-5-5", "Opus 5.5", 4, 20, 0.2, 5],
    ["claude-opus-5", "Opus 5", 5, 25, 0.5, 6.25],
    ["claude-opus-4-8", "Opus 4.8", 5, 25, 0.5, 6.25],
    ["claude-opus-4-7", "Opus 4.7", 5, 25, 0.5, 6.25],
    ["claude-opus-4-6", "Opus 4.6", 5, 25, 0.5, 6.25],
    ["claude-opus-4-5", "Opus 4.5", 5, 25, 0.5, 6.25],
    ["claude-opus-4-1", "Opus 4.1", 15, 75, 1.5, 18.75],
    ["claude-opus-4", "Opus 4", 15, 75, 1.5, 18.75],
    ["claude-sonnet-5-5", "Sonnet 5.5", 2, 10, 0.1, 2.5],
    ["claude-sonnet-5", "Sonnet 5", 2, 10, 0.2, 2.5],
    ["claude-sonnet-4-6", "Sonnet 4.6", 3, 15, 0.3, 3.75],
    ["claude-sonnet-4-5", "Sonnet 4.5", 3, 15, 0.3, 3.75],
    ["claude-haiku-5-5", "Haiku 5.5", 0.1, 0.5, 0.01, 0.125],
    ["claude-haiku-4-5", "Haiku 4.5", 1, 5, 0.1, 1.25],
    // Claude Code aliases, which resolve to the newest model of each family.
    ["fable", "Fable (latest)", 8, 40, 0.2, 10],
    ["opus", "Opus (latest)", 4, 20, 0.2, 5],
    ["sonnet", "Sonnet (latest)", 2, 10, 0.1, 2.5],
    ["haiku", "Haiku (latest)", 0.1, 0.5, 0.01, 0.125],
  ]),
  ...table("codex", OPENAI, [
    ["gpt-6.1-sol", "GPT-6.1 Sol", 2, 10, 0.1, 0],
    ["gpt-6.1-terra", "GPT-6.1 Terra", 1, 5, 0.05, 0],
    ["gpt-6-sol", "GPT-6 Sol", 2, 10, 0.2, 0],
    ["gpt-6-astra", "GPT-6 Astra", 10, 50, 1, 0],
    ["gpt-6-luna", "GPT-6 Luna", 0.1, 0.5, 0.01, 0],
    ["gpt-5.6-sol", "GPT-5.6 Sol", 4, 20, 0.4, 0],
    ["gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, 0.2, 0],
    ["gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 0.02, 0],
    ["gpt-5.5", "GPT-5.5", 5, 30, 0.5, 0],
    ["gpt-5.4", "GPT-5.4", 2.5, 15, 0.25, 0],
    ["gpt-5.4-mini", "GPT-5.4 mini", 0.75, 4.5, 0.075, 0],
    ["gpt-5.3-codex", "GPT-5.3 Codex", 1.75, 14, 0.175, 0],
    ["gpt-5.2-codex", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
    ["gpt-5.2", "GPT-5.2", 1.75, 14, 0.175, 0],
    ["gpt-5.1-codex-max", "GPT-5.1 Codex Max", 1.25, 10, 0.125, 0],
    ["gpt-5.1-codex-mini", "GPT-5.1 Codex mini", 0.25, 2, 0.025, 0],
    ["gpt-5.1-codex", "GPT-5.1 Codex", 1.25, 10, 0.125, 0],
    ["gpt-5.1", "GPT-5.1", 1.25, 10, 0.125, 0],
    ["gpt-5-codex", "GPT-5 Codex", 1.25, 10, 0.125, 0],
    ["gpt-5-mini", "GPT-5 mini", 0.25, 2, 0.025, 0],
    ["gpt-5", "GPT-5", 1.25, 10, 0.125, 0],
    ["o3", "o3", 2, 8, 0.5, 0],
    ["o4-mini", "o4-mini", 1.1, 4.4, 0.275, 0],
  ]),
];

/** Model ids as providers report them can carry a context suffix, e.g. `claude-opus-5[1m]`. */
function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "");
}

/**
 * Model vendors whose `<vendor>/<model>` ids (OpenCode's form, e.g. `anthropic/claude-opus-5-5`)
 * are priced from another provider's bundled table: the same models at the same list prices.
 */
const VENDOR_TABLES: Record<string, string> = { anthropic: "claude", openai: "codex" };

/**
 * The price for a model: user overrides first, then the bundled table; within each, an exact
 * id match, else the longest entry the id starts with at a `-` boundary (dated snapshots such
 * as `claude-sonnet-4-5-20250929`). A `<vendor>/<model>` id with no price of its own falls back
 * to the vendor's table (`anthropic/` -> Claude, `openai/` -> Codex). Null when nothing matches.
 */
export function findPrice(
  provider: string,
  model: string,
  overrides: ModelPrice[] = [],
): ModelPrice | null {
  const id = normalizeModel(model);
  for (const list of [overrides, BUNDLED_PRICES]) {
    const candidates = list.filter((p) => p.provider === provider);
    const exact = candidates.find((p) => normalizeModel(p.model) === id);
    if (exact) return exact;
    let best: ModelPrice | null = null;
    for (const p of candidates) {
      const key = normalizeModel(p.model);
      if (id.startsWith(`${key}-`) && key.length > normalizeModel(best?.model ?? "").length) {
        best = p;
      }
    }
    if (best) return best;
  }
  const slash = model.indexOf("/");
  const vendor = slash > 0 ? VENDOR_TABLES[model.slice(0, slash).toLowerCase()] : undefined;
  if (vendor && vendor !== provider) return findPrice(vendor, model.slice(slash + 1), overrides);
  return null;
}

/** USD for token counts at a price. */
export function priceTokens(tokens: TokenCounts, price: ModelPrice): number {
  const usd =
    (tokens.inputTokens * price.inputPerMTok +
      tokens.outputTokens * price.outputPerMTok +
      tokens.cacheReadTokens * price.cacheReadPerMTok +
      tokens.cacheWriteTokens * price.cacheWritePerMTok) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

/** The cost a ledger row is reported with: the provider's figure, else an estimate. */
export function costOf(
  row: TokenCounts & { provider: string; model: string; reportedCostUsd: number | null },
  overrides: ModelPrice[] = [],
): { costUsd: number; costSource: CostSource } {
  if (row.reportedCostUsd !== null) return { costUsd: row.reportedCostUsd, costSource: "reported" };
  const price = findPrice(row.provider, row.model, overrides);
  if (!price) return { costUsd: 0, costSource: "unpriced" };
  return { costUsd: priceTokens(row, price), costSource: "estimated" };
}
