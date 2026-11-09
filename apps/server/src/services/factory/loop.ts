import {
  type FactoryItem,
  type FactoryLoop,
  type FactoryLoopState,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { budgetSpend, type FactoryContext, factoryNotice, visionOf } from "./context";
import {
  budgetExceeded,
  discoveryDue,
  freeSlots,
  localDay,
  mayBuild,
  nextAreas,
  slugify,
} from "./policy";
import { advanceBuilding, advanceWatching } from "./progress";
import { triageInstructions } from "./prompts";
import { WAITING_STAGES } from "./store";
import { advanceVerifying } from "./verify";

/** Label on issues the factory created or accepted. */
export const FACTORY_LABEL = "codeden-factory";

/** What a tick needs besides the context: the daily digest hook. */
export interface TickHooks {
  /** Write the digest for `day` (called once when the day rolls over). */
  digest(project: Project, loop: FactoryLoop, day: string): Promise<unknown>;
}

/**
 * One step of a project's factory loop (§10.1). The server drives the state machine and
 * enforces the limits; the PM and the agents only do the judgement. Safe to call at any time
 * and after a restart: every step reads the persisted state and moves it forward.
 */
export async function runTick(
  ctx: FactoryContext,
  projectId: string,
  hooks: TickHooks,
): Promise<FactoryLoop> {
  const project = ctx.projects.get(projectId);
  const now = ctx.now();
  let loop = ctx.store.loopOrNew(projectId, now);
  const killed = project.killSwitch || ctx.settings.get().factory.killSwitch;
  if (!isFactoryMode(project.autonomyMode) || project.archivedAt) {
    if (loop.state !== "idle" && loop.state !== "stopped")
      loop = { ...loop, state: "idle", discovery: [] };
    return save(ctx, loop, now);
  }
  if (killed) return save(ctx, { ...loop, state: "stopped", discovery: [] }, now);
  if (loop.state === "stopped") loop = { ...loop, state: "idle" };

  // Day rollover: digest for the day that ended, fresh counters; a budget pause ends.
  const today = localDay(now);
  if (loop.day !== today) {
    if (loop.lastDigestDay !== loop.day) {
      await hooks.digest(project, loop, loop.day);
      loop = { ...loop, lastDigestDay: loop.day };
    }
    loop = { ...loop, day: today, mergesToday: 0 };
    if (loop.state === "paused" && loop.pausedReason?.startsWith("daily")) {
      loop = { ...loop, state: "idle", pausedReason: null };
    }
  }

  // Items already in flight move on even while paused (merges stay blocked, reverts excepted).
  loop = dropFinishedDiscovery(ctx, loop);
  // Watch merges first, then builds, then verification, so a PR found while building is
  // verified in the same step and a fresh merge is watched from the next one.
  for (const stage of ["watching", "building", "verifying"] as const) {
    for (const item of ctx.store.items(projectId, [stage])) {
      try {
        if (stage === "building") loop = await advanceBuilding(ctx, project, loop, item);
        else if (stage === "verifying") loop = await advanceVerifying(ctx, project, loop, item);
        else loop = await advanceWatching(ctx, project, loop, item);
      } catch (error) {
        ctx.log?.(`factory: ${item.id}: ${errorMessage(error)}`);
        ctx.store.updateItem(item.id, (i) => ({
          ...i,
          note: `Loop error: ${errorMessage(error)}`,
        }));
      }
    }
  }

  if (loop.state !== "paused") {
    const spend = budgetSpend(ctx, projectId, today, project.factoryLimits);
    const over = budgetExceeded(spend, project.factoryLimits);
    if (over) loop = { ...loop, state: "paused", pausedReason: over };
  }
  if (loop.state === "paused") return save(ctx, loop, now);

  loop = intakeIssues(ctx, project, loop);
  await intakeFailedChecks(ctx, project, loop).then((l) => {
    loop = l;
  });
  if (project.autonomyMode === "dark_factory") loop = await discover(ctx, project, loop, now);
  requestTriage(ctx, project);
  loop = await build(ctx, project, loop);
  return save(ctx, { ...loop, state: deriveState(ctx, projectId, loop) }, now);
}

function save(ctx: FactoryContext, loop: FactoryLoop, now: Date): FactoryLoop {
  return ctx.store.saveLoop({ ...loop, lastTickAt: now.toISOString() });
}

/** The loop state the panel shows: the most advanced stage with work in it. */
function deriveState(ctx: FactoryContext, projectId: string, loop: FactoryLoop): FactoryLoopState {
  const active = ctx.store.items(projectId, ["building", "verifying", "watching"]);
  if (active.some((i) => i.stage === "verifying" || i.stage === "watching")) return "verifying";
  if (active.some((i) => i.stage === "building")) return "building";
  if (loop.discovery.length > 0) return "discovering";
  return "idle";
}

/** Forget discovery runs whose sessions ended (their candidates arrive through the tool). */
function dropFinishedDiscovery(ctx: FactoryContext, loop: FactoryLoop): FactoryLoop {
  const running = loop.discovery.filter((d) => {
    const s = ctx.repo.find(d.sessionId)?.session;
    return (
      s !== undefined && ["created", "queued", "starting", "running", "waiting"].includes(s.status)
    );
  });
  return running.length === loop.discovery.length ? loop : { ...loop, discovery: running };
}

/** New issues (opened after the factory was enabled, or labelled for it) become candidates. */
function intakeIssues(ctx: FactoryContext, project: Project, loop: FactoryLoop): FactoryLoop {
  const known = new Set(
    ctx.store.items(project.id).flatMap((i) => (i.issue ? [i.issue.number] : [])),
  );
  // GitHub timestamps have second precision and clocks drift: allow a minute of slack.
  const since = loop.enabledAt ? Date.parse(loop.enabledAt) - 60_000 : Number.POSITIVE_INFINITY;
  for (const issue of ctx.github.openIssues(project.id)) {
    if (known.has(issue.number)) continue;
    const opened = issue.createdAt ? Date.parse(issue.createdAt) : 0;
    const labelled = issue.labels.includes(FACTORY_LABEL);
    if (!labelled && opened < since) continue;
    ctx.store.createItem({
      projectId: project.id,
      workKey: `issue:${issue.number}`,
      title: issue.title,
      summary: (issue.body ?? "").slice(0, 4_000),
      source: "issue",
      stage: "candidate",
      issue: { number: issue.number, url: issue.url, title: issue.title },
    });
  }
  return loop;
}

/** A failed check on the default branch becomes a candidate (once per commit). */
async function intakeFailedChecks(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  // Regressions after factory merges are handled by the watch step.
  if (ctx.store.items(project.id, ["watching"]).length > 0) return loop;
  let head: Awaited<ReturnType<typeof ctx.github.mainHead>>;
  try {
    head = await ctx.github.mainHead(project.id);
  } catch {
    return loop;
  }
  if (head.checks !== "failure" || loop.seenFailedShas.includes(head.sha)) return loop;
  const failing = head.failed.join(", ") || "CI";
  ctx.store.createItem({
    projectId: project.id,
    workKey: `factory:fix-main-${head.sha.slice(0, 7)}`,
    title: `Fix failing ${failing} on the default branch`,
    summary: `Checks failing on ${head.sha}: ${failing}.`,
    source: "failed_check",
    area: "tech_debt",
    acceptanceCriteria: [`${failing} passes on the default branch`],
    stage: "candidate",
  });
  return { ...loop, seenFailedShas: [...loop.seenFailedShas, head.sha].slice(-20) };
}

/** Dark factory: improvement finders per area when the backlog runs low. */
async function discover(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  now: Date,
): Promise<FactoryLoop> {
  const waiting = ctx.store.items(project.id, WAITING_STAGES).length;
  if (!discoveryDue(loop, waiting, now.getTime())) return loop;
  const slots = freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits);
  const areas = nextAreas(
    loop.tuning.areas,
    loop.nextArea,
    Math.min(slots, loop.tuning.discoveryPerRound),
  );
  if (areas.length === 0) return loop;
  const vision = visionOf(project).text;
  const known = ctx.store
    .items(project.id)
    .slice(0, 40)
    .map((i) => i.title);
  const runs = [...loop.discovery];
  for (const area of areas) {
    try {
      const res = await ctx.sessions.startDiscovery(project.id, area, vision, known);
      if (res.status === "started")
        runs.push({ sessionId: res.sessionId, area, startedAt: now.toISOString() });
    } catch (error) {
      ctx.log?.(`factory: discovery ${area}: ${errorMessage(error)}`);
    }
  }
  return {
    ...loop,
    discovery: runs,
    nextArea: (loop.nextArea + areas.length) % Math.max(1, loop.tuning.areas.length),
    lastDiscoveryAt: now.toISOString(),
  };
}

/** Wake the PM once for candidates it has not been asked about. */
function requestTriage(ctx: FactoryContext, project: Project): void {
  const fresh = ctx.store.items(project.id, ["candidate"]).filter((i) => !i.triageRequestedAt);
  if (fresh.length === 0) return;
  const at = ctx.now().toISOString();
  factoryNotice(ctx, {
    id: `factory.triage:${project.id}:${fresh.map((i) => i.id.slice(0, 8)).join(",")}`.slice(
      0,
      200,
    ),
    projectId: project.id,
    target: "pm",
    event: "triage_needed",
    title: `Factory: ${fresh.length} candidate${fresh.length === 1 ? "" : "s"} to triage`,
    text: triageInstructions(fresh, project.autonomyMode === "dark_factory"),
    itemIds: fresh.map((i) => i.id),
  });
  for (const item of fresh) ctx.store.updateItem(item.id, (i) => ({ ...i, triageRequestedAt: at }));
}

/** Start builders for the best-scored backlog items, within slots and the merge cap. */
async function build(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const backlog = ctx.store
    .items(project.id, ["backlog"])
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.createdAt.localeCompare(b.createdAt));
  const vision = visionOf(project).text;
  for (const item of backlog) {
    const inFlight = ctx.store.items(project.id, ["building", "verifying"]).length;
    if (!mayBuild(loop.mergesToday, inFlight, project.factoryLimits)) break;
    if (freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) === 0) break;
    await startBuilder(ctx, item, vision, loop);
  }
  return loop;
}

async function startBuilder(
  ctx: FactoryContext,
  item: FactoryItem,
  vision: string,
  loop: FactoryLoop,
): Promise<void> {
  const provider = loop.tuning.builderProvider;
  try {
    const res = await ctx.sessions.startBuilder(item, vision, provider);
    if (res.status === "conflict") {
      const other = res.existing.map((w) => w.workKey).join(", ");
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        note: `Waiting: overlaps running work (${other})`,
      }));
      return;
    }
    if (res.status !== "started" && res.status !== "queued") return;
    const session = ctx.repo.find(res.sessionId)?.session;
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "building",
      builderSessionId: res.sessionId,
      builderProvider: session?.provider ?? (provider === "auto" ? null : provider),
      note: null,
    }));
  } catch (error) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Build not started: ${errorMessage(error)}`,
    }));
  }
}

/** A work key for a new candidate from its title. */
export function candidateWorkKey(title: string): string {
  return `factory:${slugify(title)}`;
}
