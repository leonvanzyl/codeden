import type {
  ModelInfo,
  ModelRef,
  ProviderInfo,
  ReasoningEffort,
  SetupCheck,
} from "@codeden/contracts";
import { aliasFor, DEFAULT_MODEL_ID } from "./alias";

/**
 * Pure rules behind the provider, model and effort picker. Nothing here branches on a provider
 * id: models, effort levels and capabilities all come from the provider itself.
 */

/** What the picker edits. `model: null` and `effort: null` mean "use the default". */
export interface ModelChoice {
  provider: string;
  model: string | null;
  effort: ReasoningEffort | null;
}

export const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const EFFORT_NAME: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A model's effort levels from lowest to highest, without duplicates. */
export function sortEfforts(efforts: readonly ReasoningEffort[]): ReasoningEffort[] {
  return EFFORT_ORDER.filter((e) => efforts.includes(e));
}

export { aliasFor, DEFAULT_MODEL_ID };

/** The model a choice points at, and how it got there. */
export interface ResolvedModel {
  model: ModelInfo | undefined;
  /** The choice is "the default" (null or `default`), resolved to the provider's default model. */
  followsDefault: boolean;
  /** A stored id the provider no longer lists; shown as-is rather than swapped for another. */
  missing: string | null;
}

/**
 * Resolve a stored model id: an exact match; `null` or `default` as the provider's default model
 * (its `isDefault` entry, else its first); a full id as the alias entry that runs it (see
 * `aliasFor`); anything else as missing.
 */
export function resolveModel(
  provider: ProviderInfo | undefined,
  modelId: string | null,
): ResolvedModel {
  const exact = modelId !== null ? provider?.models.find((m) => m.id === modelId) : undefined;
  if (exact) return { model: exact, followsDefault: false, missing: null };
  if (modelId === null || modelId === DEFAULT_MODEL_ID) {
    const listed = provider?.models.find((m) => m.id === DEFAULT_MODEL_ID);
    if (listed) return { model: listed, followsDefault: false, missing: null };
    const model = provider?.models.find((m) => m.isDefault) ?? provider?.models[0];
    return { model, followsDefault: Boolean(model), missing: null };
  }
  const alias = aliasFor(provider, modelId);
  if (alias) return { model: alias, followsDefault: false, missing: null };
  return { model: undefined, followsDefault: false, missing: modelId };
}

/** How a resolved model is named: "Default (x)" when it follows the provider's default. */
export function modelName(resolved: ResolvedModel): string | null {
  if (resolved.missing) return resolved.missing;
  if (!resolved.model) return null;
  return resolved.followsDefault ? `Default (${resolved.model.label})` : resolved.model.label;
}

/** Effort levels the picker should offer for a model (none when the provider has no effort). */
export function effortLevels(
  provider: ProviderInfo | undefined,
  model: ModelInfo | undefined,
): ReasoningEffort[] {
  if (!provider?.capabilities.reasoningEffort || !model) return [];
  return sortEfforts(model.efforts);
}

/**
 * Effort levels for a resolved choice, and the default among them. A stored id the provider
 * doesn't list (and no alias covers) gets the provider default model's levels: the provider
 * still runs it, and its effort can still be set.
 */
export function resolvedEfforts(
  provider: ProviderInfo | undefined,
  resolved: ResolvedModel,
): { levels: ReasoningEffort[]; defaultEffort: ReasoningEffort | undefined } {
  const model = resolved.missing ? resolveModel(provider, null).model : resolved.model;
  return { levels: effortLevels(provider, model), defaultEffort: model?.defaultEffort };
}

/**
 * Keep an effort valid for a model. A supported value is kept; otherwise the model's default,
 * otherwise the nearest supported level. Models without levels get `null`, and `null` (use the
 * default) stays `null`.
 */
export function clampEffort(
  levels: readonly ReasoningEffort[],
  effort: ReasoningEffort | null,
  defaultEffort?: ReasoningEffort,
): ReasoningEffort | null {
  if (levels.length === 0 || effort === null) return null;
  if (levels.includes(effort)) return effort;
  if (defaultEffort && levels.includes(defaultEffort)) return defaultEffort;
  const want = EFFORT_ORDER.indexOf(effort);
  let best = levels[0] ?? null;
  for (const level of levels) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(level) - want);
    if (best === null || distance < Math.abs(EFFORT_ORDER.indexOf(best) - want)) best = level;
  }
  return best;
}

/** The effort that will actually run: the chosen one if valid, else the model's default. */
export function effectiveEffort(
  levels: readonly ReasoningEffort[],
  effort: ReasoningEffort | null,
  defaultEffort?: ReasoningEffort,
): ReasoningEffort | null {
  if (levels.length === 0) return null;
  const chosen = clampEffort(levels, effort, defaultEffort);
  if (chosen) return chosen;
  if (defaultEffort && levels.includes(defaultEffort)) return defaultEffort;
  return levels[Math.floor((levels.length - 1) / 2)] ?? null;
}

/** The choice after picking a model: the effort is clamped to what that model supports. */
export function chooseModel(
  current: ModelChoice,
  provider: ProviderInfo,
  model: ModelInfo,
): ModelChoice {
  const levels = effortLevels(provider, model);
  return {
    provider: provider.id,
    model: model.id,
    effort: clampEffort(levels, current.effort, model.defaultEffort),
  };
}

// ---------------------------------------------------------------- availability

/** Whether a provider can start sessions on this machine, and why not. */
export interface Availability {
  ready: boolean;
  /** Short reason, e.g. "Not signed in". Null when ready. */
  reason: string | null;
  /** The detection message, e.g. "Installed (0.58.0) but not signed in". */
  detail: string | null;
  /** The command that fixes it, when detection knows one. */
  command: string | null;
}

const READY: Availability = { ready: true, reason: null, detail: null, command: null };

/**
 * Availability from the setup checks, matched by provider id. A provider without a check (or
 * before the first check finishes) counts as ready: the runner loaded it.
 */
export function providerAvailability(
  providerId: string,
  checks: readonly SetupCheck[] | undefined,
): Availability {
  const check = checks?.find((c) => c.id === providerId);
  if (!check || check.state === "ok" || check.state === "warning") return READY;
  const reason = !check.installed
    ? check.broken?.length
      ? "Installed but broken"
      : "Not installed"
    : check.loggedIn === false
      ? "Not signed in"
      : "Not ready";
  return { ready: false, reason, detail: check.message, command: check.fix?.command ?? null };
}

// ---------------------------------------------------------------- tabs and search

/** Id of the Favourites tab; provider ids can't clash with it (they never contain a colon). */
export const FAVORITES_TAB = ":favorites";

/** One tab in the rail: the starred models across providers, or one provider's models. */
export type PickerTab =
  | { kind: "favorites"; id: typeof FAVORITES_TAB; lockedReason: null }
  | {
      kind: "provider";
      id: string;
      provider: ProviderInfo;
      availability: Availability;
      /** Set when the tab cannot be opened, e.g. a session's provider is fixed. */
      lockedReason: string | null;
      /**
       * A locked provider the session can be handed off to (§9): `ready` opens the handoff
       * dialog on click, `blocked` says why not now. Absent when no handoff is offered.
       */
      handoff?: "ready" | "blocked";
    };
export type ProviderTab = Extract<PickerTab, { kind: "provider" }>;

/** "Wait for the turn" → "wait for the turn", to follow a colon. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Why a provider is locked in this session, and whether a handoff to it is offered. */
function lockedTab(
  provider: ProviderInfo,
  lockedProvider: string | undefined,
  handoff: { blocked: string | null } | undefined,
): Pick<ProviderTab, "lockedReason" | "handoff"> {
  if (!lockedProvider || provider.id === lockedProvider) return { lockedReason: null };
  const name = provider.displayName;
  if (!handoff) {
    return {
      lockedReason: `${name} can't be used in this session. Start a new session to switch providers.`,
    };
  }
  return handoff.blocked
    ? {
        lockedReason: `Continue in a new ${name} session. Not available now: ${lowerFirst(handoff.blocked)}.`,
        handoff: "blocked",
      }
    : { lockedReason: `Continue in a new ${name} session`, handoff: "ready" };
}

/**
 * The rail's tabs: Favourites first (when offered), then one per provider. In a session
 * (`lockedProvider`) the other providers are locked; with `handoff` they offer to continue the
 * session in a new one on that provider instead.
 */
export function providerTabs(
  providers: readonly ProviderInfo[],
  checks: readonly SetupCheck[] | undefined,
  lockedProvider: string | undefined,
  opts: { favorites?: boolean; handoff?: { blocked: string | null } } = {},
): PickerTab[] {
  const tabs: PickerTab[] = providers.map((provider) => ({
    kind: "provider" as const,
    id: provider.id,
    provider,
    availability: providerAvailability(provider.id, checks),
    ...lockedTab(provider, lockedProvider, opts.handoff),
  }));
  return opts.favorites
    ? [{ kind: "favorites", id: FAVORITES_TAB, lockedReason: null }, ...tabs]
    : tabs;
}

/** Provider tabs that can be opened. */
export function openProviderTabs(tabs: readonly PickerTab[]): ProviderTab[] {
  return tabs.filter((t): t is ProviderTab => t.kind === "provider" && !t.lockedReason);
}

/** The next tab that can be opened (Favourites included), wrapping around. */
export function adjacentTab(
  tabs: readonly PickerTab[],
  currentId: string,
  direction: 1 | -1,
): PickerTab | undefined {
  const open = tabs.filter((t) => !t.lockedReason);
  if (open.length === 0) return undefined;
  const index = open.findIndex((t) => t.id === currentId);
  if (index < 0) return direction === 1 ? open[0] : open.at(-1);
  return open[(index + direction + open.length) % open.length];
}

/** A row in the model list. */
export interface ModelRow {
  key: string;
  provider: ProviderInfo;
  model: ModelInfo;
}

export function rowKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function rows(provider: ProviderInfo): ModelRow[] {
  return provider.models.map((model) => ({ key: rowKey(provider.id, model.id), provider, model }));
}

/**
 * Starred models as rows, in the order they were starred. Favourites of providers that can't be
 * used here, or whose model the provider no longer lists, are left out (but stay saved).
 */
export function favoriteRows(
  favorites: readonly ModelRef[],
  providers: readonly ProviderInfo[],
): ModelRow[] {
  const seen = new Set<string>();
  const out: ModelRow[] = [];
  for (const ref of favorites) {
    const provider = providers.find((p) => p.id === ref.provider);
    const model = provider?.models.find((m) => m.id === ref.model);
    const key = rowKey(ref.provider, ref.model);
    if (!provider || !model || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, provider, model });
  }
  return out;
}

/** The rows of one tab; `providers` are the ones that can be used here. */
export function tabRows(
  tab: PickerTab | undefined,
  providers: readonly ProviderInfo[],
  favorites: readonly ModelRef[],
): ModelRow[] {
  if (!tab) return [];
  return tab.kind === "favorites" ? favoriteRows(favorites, providers) : rows(tab.provider);
}

/** Add or remove a favourite, keeping the order of the rest. */
export function toggleFavorite(favorites: readonly ModelRef[], ref: ModelRef): ModelRef[] {
  const has = favorites.some((f) => f.provider === ref.provider && f.model === ref.model);
  return has
    ? favorites.filter((f) => f.provider !== ref.provider || f.model !== ref.model)
    : [...favorites, ref];
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s_\-.]+/g, " ")
    .trim();

/** Lower is better; null when a search token matches nothing. */
function scoreRow(row: ModelRow, tokens: string[], phrase: string): number | null {
  const label = normalize(row.model.label);
  if (phrase === label || phrase === normalize(row.model.id)) return -100;
  const fields = [
    label,
    normalize(row.model.id),
    normalize(row.provider.displayName),
    normalize(row.model.description ?? ""),
  ];
  let score = 0;
  for (const token of tokens) {
    let best: number | null = null;
    fields.forEach((field, i) => {
      const at = field.indexOf(token);
      if (at < 0) return;
      const where = at === 0 ? 0 : field[at - 1] === " " ? 1 : 2;
      const s = i * 10 + where;
      if (best === null || s < best) best = s;
    });
    if (best === null) return null;
    score += best;
  }
  return score;
}

/**
 * Rank models across providers for a search. Equal matches put favourites first, then keep
 * provider and model order.
 */
export function searchRows(
  providers: readonly ProviderInfo[],
  query: string,
  favorites: readonly ModelRef[] = [],
): ModelRow[] {
  const phrase = normalize(query);
  const tokens = phrase.split(" ").filter(Boolean);
  const all = providers.flatMap(rows);
  if (tokens.length === 0) return all;
  const starred = new Set(favorites.map((f) => rowKey(f.provider, f.model)));
  return all
    .map((row, order) => ({
      row,
      order,
      score: scoreRow(row, tokens, phrase),
      star: starred.has(row.key) ? 0 : 1,
    }))
    .filter((r): r is typeof r & { score: number } => r.score !== null)
    .sort((a, b) => a.score - b.score || a.star - b.star || a.order - b.order)
    .map((r) => r.row);
}

/**
 * What the trigger names: the model ("Default (x)" when it follows the default), or
 * "Provider · Model" when the provider lists a single model, such as its fallback "Default".
 */
export function triggerText(provider: ProviderInfo | undefined, resolved: ResolvedModel) {
  const name = modelName(resolved);
  if (!provider) return name ?? "Choose a model";
  if (!name) return provider.displayName;
  return provider.models.length <= 1 && !resolved.missing
    ? `${provider.displayName} · ${name}`
    : name;
}
