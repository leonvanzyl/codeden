import type {
  AutonomyLevel,
  ConflictRecord,
  ProviderInfo,
  ReasoningEffort,
  StartSessionRequestInit,
  StartWorkResult,
  UserInputInit,
} from "@codeden/contracts";

/**
 * The New session draft (§13): a session view whose first send starts the session. These are
 * its pure rules: the defaults it starts from and the start request it sends.
 */

/** Conflicts not persisted by the server (no `conflictId`) are retried with a fresh start. */
export const LOCAL_CONFLICT_PREFIX = "local:";

/** What the user picked in the draft; `null` means "the default". */
export interface DraftChoice {
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  autonomy: AutonomyLevel | null;
  /** Start in plan mode (sent only when the provider reports `capabilities.planMode`). */
  planMode: boolean;
}

export const emptyChoice: DraftChoice = {
  provider: null,
  model: null,
  effort: null,
  autonomy: null,
  planMode: false,
};

/** A default provider with the model and effort that go with it (model ids are per provider). */
export interface DefaultAgent {
  /** A provider id; `auto` (Settings) or null names none. */
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
}

/** Where the defaults come from: the runner's providers, the project and Settings. */
export interface DraftDefaults {
  providers: ProviderInfo[];
  project:
    | {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultEffort: ReasoningEffort | null;
        autonomy: AutonomyLevel | null;
      }
    | undefined;
  /** Settings → Providers → Agent sessions. */
  agent: DefaultAgent | null;
  /** Settings → Autonomy default. */
  defaultAutonomy: AutonomyLevel;
}

/** The draft's choice with its defaults filled in: what the pickers show and the start sends. */
export interface ResolvedDraft {
  provider: ProviderInfo | undefined;
  model: string | null;
  /** Sent only when the provider reports `capabilities.reasoningEffort`. */
  effort: ReasoningEffort | null;
  autonomy: AutonomyLevel;
  /** On only where the provider supports plan mode. */
  planMode: boolean;
}

/**
 * Fill in the defaults, so the pickers show what the first send will start:
 * - provider: the one picked, else the project's default, else Settings → Agent sessions, else
 *   the first ready provider (a provider the runner doesn't list is skipped);
 * - model and effort: what was picked for that provider (a custom model id included), else the
 *   first default naming that provider and a model or effort (the project's, then Settings'),
 *   else the provider's default model and the model's own effort. A default for another provider
 *   never applies: its model id means nothing there;
 * - autonomy: the one picked, else the project's, else the Settings default.
 */
export function resolveDraftChoice(choice: DraftChoice, defaults: DraftDefaults): ResolvedDraft {
  const { providers, project } = defaults;
  const known = (id: string | null | undefined) =>
    id && providers.some((p) => p.id === id) ? id : null;
  const providerId =
    known(choice.provider) ??
    known(project?.defaultProvider) ??
    known(defaults.agent?.provider) ??
    providers[0]?.id ??
    null;
  const provider = providers.find((p) => p.id === providerId);
  // What was picked for another provider (one that is gone now) doesn't carry over.
  const mine = provider !== undefined && (choice.provider ?? provider.id) === provider.id;
  const projectAgent: DefaultAgent | null = project
    ? {
        provider: project.defaultProvider,
        model: project.defaultModel,
        effort: project.defaultEffort,
      }
    : null;
  const preset = [projectAgent, defaults.agent].find(
    (d) => d && d.provider === provider?.id && (d.model !== null || d.effort !== null),
  );
  const fallback = provider?.models.find((m) => m.isDefault) ?? provider?.models[0];
  return {
    provider,
    model: (mine ? choice.model : null) ?? preset?.model ?? fallback?.id ?? null,
    effort: provider?.capabilities.reasoningEffort
      ? ((mine ? choice.effort : null) ?? preset?.effort ?? null)
      : null,
    autonomy: choice.autonomy ?? project?.autonomy ?? defaults.defaultAutonomy,
    planMode: choice.planMode && (provider?.capabilities.planMode ?? false),
  };
}

/**
 * The choice after the model picker changed provider, model or effort: switching to a provider
 * without plan mode turns Plan off, so it can't come back on unseen when switching back.
 */
export function pickModel(
  choice: DraftChoice,
  next: { provider: string; model: string | null; effort: ReasoningEffort | null },
  providers: ProviderInfo[],
): DraftChoice {
  const planSupported =
    providers.find((p) => p.id === next.provider)?.capabilities.planMode ?? false;
  return { ...choice, ...next, planMode: choice.planMode && planSupported };
}

/** `POST /api/sessions` for the draft's first message. */
export function buildStartRequest(
  projectId: string,
  input: UserInputInit,
  resolved: ResolvedDraft,
  workKey: string,
): StartSessionRequestInit {
  const key = workKey.trim();
  return {
    projectId,
    input,
    autonomy: resolved.autonomy,
    ...(resolved.planMode ? { planMode: true } : {}),
    ...(resolved.provider ? { provider: resolved.provider.id } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.effort ? { effort: resolved.effort } : {}),
    ...(key ? { workKey: key } : {}),
  };
}

/**
 * The purpose a start takes from its text, as the server derives it: the first line that isn't
 * blank, shortened to 120 characters. `null` for a draft without text.
 */
export function draftPurpose(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * A conflict the server did not persist (no `conflictId`), shown and resolved like a persisted
 * one: its decisions retry the start request.
 */
export function localConflict(
  request: StartSessionRequestInit,
  result: Extract<StartWorkResult, { status: "conflict" }>,
  now = new Date(),
): ConflictRecord {
  return {
    id: `${LOCAL_CONFLICT_PREFIX}${now.getTime()}`,
    projectId: request.projectId,
    request: {
      purpose: draftPurpose(request.input?.text ?? "") ?? "New session",
      workKey: request.workKey || result.existing[0]?.workKey || "request:new",
      startedBy: { kind: "user" },
    },
    existing: result.existing,
    start: JSON.parse(JSON.stringify(request)),
    status: "open",
    resolution: null,
    outcome: null,
    createdAt: now.toISOString(),
    resolvedAt: null,
  };
}
