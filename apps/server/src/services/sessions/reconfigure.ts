import type { AutonomyLevel, Session, UpdateSessionRequest } from "@codeden/contracts";
import { type RunnerPort, runnerErrorCode } from "../runner-port";
import type { SessionRepo, StoredStartMeta } from "./repo";

/**
 * Settings waiting for the runner: model/effort for the session's next turn, and an autonomy
 * or plan mode change the runner could not take when it was made.
 */
export type PendingConfig = {
  model?: string | null;
  effort?: Session["effort"];
  autonomy?: AutonomyLevel;
  planMode?: boolean;
};

/** The settings pushed to the live provider session at once. */
type LiveConfig = Pick<PendingConfig, "autonomy" | "planMode">;

type MetaWithPending = StoredStartMeta & { pendingConfig?: PendingConfig };

/** How long `PATCH` waits for the runner to take an autonomy or plan mode change. */
const LIVE_TIMEOUT_MS = 10_000;

function fallbackMeta(): StoredStartMeta {
  return { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] };
}

/** Merge `change` into the pending config (keys set to undefined are removed). */
function setPending(repo: SessionRepo, id: string, change: Partial<PendingConfig>): void {
  repo.setStartMeta(id, (m) => {
    const { pendingConfig, ...meta } = (m ?? fallbackMeta()) as MetaWithPending;
    const next: Record<string, unknown> = { ...pendingConfig, ...change };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    return (
      Object.keys(next).length > 0 ? { ...meta, pendingConfig: next } : meta
    ) as StoredStartMeta;
  });
}

/**
 * `PATCH /api/sessions/:id`: update model, effort, autonomy, plan mode or title. Every change
 * is saved on the session (`session.updated`), so it survives a restart and later starts and
 * resumes use it.
 * - Model and effort are remembered as pending and applied right before the next turn
 *   (`applyPendingConfig`), so a running turn keeps its settings.
 * - Autonomy and plan mode are pushed to the live provider session at once: from the next
 *   tool call where the provider supports it, otherwise from the next turn. If the runner
 *   cannot take them now, they are retried before the next turn.
 */
export async function updateSession(
  repo: SessionRepo,
  runner: RunnerPort,
  id: string,
  req: UpdateSessionRequest,
): Promise<Session> {
  const change: PendingConfig = {};
  if (req.model !== undefined) change.model = req.model;
  if (req.effort !== undefined) change.effort = req.effort;
  const session = repo.update(id, (s) => ({
    ...s,
    ...(change.model !== undefined ? { model: change.model } : {}),
    ...(change.effort !== undefined ? { effort: change.effort } : {}),
    ...(req.autonomy !== undefined ? { autonomy: req.autonomy } : {}),
    ...(req.planMode !== undefined ? { planMode: req.planMode } : {}),
    ...(req.title !== undefined ? { title: req.title } : {}),
  }));
  if (Object.keys(change).length > 0) setPending(repo, id, change);
  const live: LiveConfig = {};
  if (req.autonomy !== undefined) live.autonomy = session.autonomy;
  if (req.planMode !== undefined) live.planMode = session.planMode ?? false;
  if (Object.keys(live).length > 0) await applyLive(repo, runner, session.id, live);
  return session;
}

/**
 * Tell the runner about the session's autonomy and/or plan mode. When the runner does not
 * host the session, or cannot be reached, the change stays pending; a later start or resume
 * reads it from the session anyway.
 */
async function applyLive(repo: SessionRepo, runner: RunnerPort, id: string, live: LiveConfig) {
  try {
    await runner.request({ name: "session.configure", sessionId: id, ...live }, LIVE_TIMEOUT_MS);
    const done = Object.fromEntries(Object.keys(live).map((key) => [key, undefined]));
    setPending(repo, id, done);
  } catch {
    setPending(repo, id, live);
  }
}

/**
 * Apply pending settings on the runner before the next turn. When the runner no longer hosts
 * the session, the resume that follows opens it with the new settings anyway. Returns a
 * warning when the provider cannot change them live (they apply on the next resume).
 */
export async function applyPendingConfig(
  repo: SessionRepo,
  runner: RunnerPort,
  session: Session,
): Promise<string | undefined> {
  const meta = repo.find(session.id)?.startMeta as MetaWithPending | null | undefined;
  const pending = meta?.pendingConfig;
  if (!pending) return undefined;
  const clear = () =>
    repo.setStartMeta(session.id, (m) => {
      const { pendingConfig: _done, ...rest } = (m ?? fallbackMeta()) as MetaWithPending;
      return rest;
    });
  try {
    await runner.request({ name: "session.configure", sessionId: session.id, ...pending });
    clear();
    return undefined;
  } catch (error) {
    const code = runnerErrorCode(error);
    if (code === "unknown_session") {
      clear();
      return undefined;
    }
    return `Session settings not applied live (${code ?? "error"}); they apply when the session is resumed.`;
  }
}
