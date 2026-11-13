import type {
  DiscoveryArea,
  FactoryFileIssueRequest,
  FactoryFinding,
  FactoryItem,
  FactoryLoop,
  FactoryPlanRoundRequest,
  ScoutFinding,
  ScoutLensRun,
  Session,
} from "@codeden/contracts";
import { badRequest, conflict, errorMessage } from "../errors";
import { TYPE_LABEL } from "./classify";
import { type FactoryContext, visionOf } from "./context";
import { FACTORY_LABEL } from "./intake";
import { slugify } from "./policy";
import { lensPrompt } from "./prompts-scout";
import { defaultBranch, knownTitles, SCOUT_SLOT } from "./scout";
import { busySlots, slotsFor } from "./slots";
import { ACTIVE_STAGES, WAITING_STAGES } from "./store";
import { wipOf, wipText } from "./wip";

/**
 * What the scout and its area reviewers (`lenses` in the code) report (§10.1): the scout's plan
 * for the round, the area reviewers' findings and the issues the scout files. Each changes the loop record, so the service runs
 * them one at a time with the loop's ticks.
 */

const PRIORITY_SCORE = { high: 0.9, normal: 0.6, low: 0.3 } as const;

function scoutRound(
  ctx: FactoryContext,
  session: Session,
): { loop: FactoryLoop; projectId: string } {
  if (!session.projectId) throw badRequest("Only a project's scout can do this", "not_the_scout");
  const loop = ctx.store.loopOrNew(session.projectId, ctx.now());
  if (loop.scout.sessionId !== session.id) {
    throw badRequest("Only the project's factory scout can do this", "not_the_scout");
  }
  if (!loop.scout.round) {
    throw conflict("No scout round is running; wait for the next one", "no_round");
  }
  return { loop, projectId: session.projectId };
}

/** Why a review area the scout asked for got no area reviewer this round. */
type DropReason = "not_allowed" | "duplicate" | "round_limit" | "no_slot" | "failed";
type Dropped = Record<DropReason, DiscoveryArea[]>;

/**
 * The review areas that get an area reviewer, in the scout's order: allowed areas, each once, at
 * most `perRound` of them and no more than there are free `slots`. The rest are dropped with
 * their reason.
 */
export function pickLenses(
  requests: FactoryPlanRoundRequest["lenses"],
  limits: { areas: readonly DiscoveryArea[]; perRound: number; slots: number },
): { picked: FactoryPlanRoundRequest["lenses"]; dropped: Dropped } {
  const allowed = new Set(limits.areas);
  const seen = new Set<DiscoveryArea>();
  const picked: FactoryPlanRoundRequest["lenses"] = [];
  const dropped: Dropped = {
    not_allowed: [],
    duplicate: [],
    round_limit: [],
    no_slot: [],
    failed: [],
  };
  for (const lens of requests) {
    if (!allowed.has(lens.area)) {
      dropped.not_allowed.push(lens.area);
      continue;
    }
    if (seen.has(lens.area)) {
      dropped.duplicate.push(lens.area);
      continue;
    }
    const position = seen.size;
    seen.add(lens.area);
    if (position >= limits.perRound) dropped.round_limit.push(lens.area);
    else if (position >= limits.slots) dropped.no_slot.push(lens.area);
    else picked.push(lens);
  }
  return { picked, dropped };
}

/** What the scout is told about the review areas that got no area reviewer, and why. */
function dropNote(
  dropped: Dropped,
  opts: { perRound: number; busy: number; slots: number; maxConcurrent: number },
): string {
  const list = (areas: DiscoveryArea[]) => areas.map((a) => `\`${a}\``).join(", ");
  const parts: string[] = [];
  if (dropped.not_allowed.length > 0) {
    parts.push(`${list(dropped.not_allowed)}: not one of this project's review areas.`);
  }
  if (dropped.duplicate.length > 0) {
    parts.push(`${list(dropped.duplicate)}: asked for more than once.`);
  }
  if (dropped.round_limit.length > 0) {
    parts.push(
      `${list(dropped.round_limit)}: over this round's limit of ${opts.perRound} review area${opts.perRound === 1 ? "" : "s"}.`,
    );
  }
  if (dropped.no_slot.length > 0) {
    const free = Math.max(0, opts.maxConcurrent - opts.busy);
    const waiting =
      free > opts.slots
        ? `, ${free - opts.slots} free one${free - opts.slots === 1 ? " goes" : "s go"} to reviews, fixes or builds waiting for an agent`
        : "";
    const given =
      opts.slots > 0 ? ` and this round's area reviewers get the other ${opts.slots}` : "";
    parts.push(
      `${list(dropped.no_slot)}: no free agent slot (Agents at once is ${opts.maxConcurrent}; other factory sessions hold ${opts.busy}${waiting}${given}). Raising Agents at once in the factory limits allows more area reviewers.`,
    );
  }
  if (dropped.failed.length > 0) {
    parts.push(`${list(dropped.failed)}: the area reviewer couldn't start.`);
  }
  return parts.length > 0 ? ` Not started: ${parts.join(" ")}` : "";
}

/** `factory_plan_round`: start (or wake) the area reviewers the scout asked for, within the limits. */
export async function planRound(
  ctx: FactoryContext,
  session: Session,
  req: FactoryPlanRoundRequest,
): Promise<{ lenses: Array<{ area: DiscoveryArea; sessionId: string }>; next: string }> {
  const { loop, projectId } = scoutRound(ctx, session);
  const round = loop.scout.round;
  if (round?.phase !== "planning") {
    throw conflict("This round is already planned", "already_planned");
  }
  const project = ctx.projects.get(projectId);
  // The scout ends its turn right after planning, so the slot it holds now goes to a reviewer;
  // builders, reviewers and every other factory session keep theirs, and work waiting for an
  // agent (reviews, fixes, rebases, builds) gets free ones first (§10.1, `slots.ts`).
  const busy = busySlots(ctx, projectId, session.id);
  const slots = slotsFor(ctx, project, "scout", SCOUT_SLOT, session.id);
  const { picked, dropped } = pickLenses(req.lenses, {
    areas: loop.tuning.areas,
    perRound: loop.tuning.discoveryPerRound,
    slots,
  });
  const at = ctx.now().toISOString();
  const lensSessions = { ...loop.scout.lensSessions };
  const started: ScoutLensRun[] = [];
  for (const lens of picked) {
    const reuse = ctx.sessions.reusable(lensSessions[lens.area]);
    const text = lensPrompt({
      area: lens.area,
      focus: lens.focus,
      vision: visionOf(project).text,
      defaultBranch: defaultBranch(project),
      known: knownTitles(ctx, projectId),
      firstRun: !reuse,
    });
    try {
      let sessionId: string;
      if (reuse) {
        await ctx.sessions.message(reuse.id, text);
        sessionId = reuse.id;
      } else {
        const res = await ctx.sessions.startLens(projectId, lens.area, text);
        if (res.status !== "started" && res.status !== "queued") {
          dropped.failed.push(lens.area);
          continue;
        }
        sessionId = res.sessionId;
      }
      lensSessions[lens.area] = sessionId;
      started.push({
        area: lens.area,
        focus: lens.focus,
        sessionId,
        sentAt: at,
        reported: false,
        nudgedAt: null,
      });
    } catch (error) {
      ctx.log?.(`factory: area reviewer ${lens.area}: ${errorMessage(error)}`);
      dropped.failed.push(lens.area);
    }
  }
  ctx.store.saveLoop({
    ...loop,
    scout: {
      ...loop.scout,
      lensSessions,
      round: {
        ...round,
        phase: started.length > 0 ? "reviewing" : "filing",
        lenses: started,
        sentAt: at,
      },
    },
  });
  const note = dropNote(dropped, {
    perRound: loop.tuning.discoveryPerRound,
    busy,
    slots,
    maxConcurrent: project.factoryLimits.maxConcurrentSessions,
  });
  return {
    lenses: started.map((l) => ({ area: l.area, sessionId: l.sessionId })),
    next:
      started.length > 0
        ? `Started ${started.map((l) => l.area).join(", ")}.${note} End your turn now: CodeDen sends you their findings when they are done.`
        : `No area reviewers this round.${note} Review by yourself now and file at most ${loop.tuning.maxIssuesPerRound} issues with \`factory_file_issue\`, then end your turn.`,
  };
}

/** `factory_report_findings`: an area reviewer reports what it found this round. */
export function reportFindings(
  ctx: FactoryContext,
  session: Session,
  findings: FactoryFinding[],
): { recorded: number; skipped: string[]; message: string } {
  if (!session.projectId) {
    throw badRequest("Only one of the scout's area reviewers can report findings", "not_a_lens");
  }
  const loop = ctx.store.loopOrNew(session.projectId, ctx.now());
  const round = loop.scout.round;
  const lens = round?.lenses.find((l) => l.sessionId === session.id);
  if (round?.phase !== "reviewing" || !lens) {
    throw conflict("No review round is waiting for your findings", "no_round");
  }
  if (lens.reported) return { recorded: 0, skipped: [], message: "Already reported this round." };
  const known = new Set([
    ...knownTitles(ctx, session.projectId).map(slugify),
    ...round.findings.map((f) => slugify(f.title)),
  ]);
  const added: ScoutFinding[] = [];
  const skipped: string[] = [];
  for (const f of findings) {
    const slug = slugify(f.title);
    if (known.has(slug) || round.findings.length + added.length >= 60) {
      skipped.push(f.title);
      continue;
    }
    known.add(slug);
    added.push({
      ...f,
      id: `${lens.area}-${round.findings.length + added.length + 1}`,
      area: lens.area,
    });
  }
  ctx.store.saveLoop({
    ...loop,
    scout: {
      ...loop.scout,
      round: {
        ...round,
        findings: [...round.findings, ...added],
        lenses: round.lenses.map((l) =>
          l.sessionId === session.id ? { ...l, reported: true } : l,
        ),
      },
    },
  });
  return {
    recorded: added.length,
    skipped,
    message: "Recorded. End your turn; the scout decides what to file.",
  };
}

/** `factory_file_issue`: the scout files one piece of work; it enters its pipeline queued. */
export async function fileIssue(
  ctx: FactoryContext,
  session: Session,
  req: FactoryFileIssueRequest,
): Promise<{ itemId: string; issue: FactoryItem["issue"]; filedThisRound: number }> {
  const { loop, projectId } = scoutRound(ctx, session);
  const round = loop.scout.round;
  if (!round) throw conflict("No scout round is running", "no_round");
  if (round.phase === "reviewing") {
    throw conflict(
      "The area reviewers are still reviewing; end your turn and wait for their findings",
      "lenses_reviewing",
    );
  }
  if (round.filed >= loop.tuning.maxIssuesPerRound) {
    throw conflict(
      `This round's limit of ${loop.tuning.maxIssuesPerRound} issues is reached; end your turn`,
      "round_limit",
    );
  }
  // At the work-in-progress limit the factory finishes open work before it takes on more.
  const wip = wipOf(ctx, ctx.projects.get(projectId), loop);
  if (wip.holding) {
    throw conflict(
      `${wipText(wip)}: the factory files no new issues until open pull requests merge; end your turn`,
      "wip_limit",
    );
  }
  const slug = slugify(req.title);
  const duplicate = ctx.store
    .items(projectId, [...WAITING_STAGES, ...ACTIVE_STAGES, "escalated"])
    .find((i) => slugify(i.title) === slug);
  if (duplicate) {
    throw conflict(`Already open as "${duplicate.title}"`, "duplicate");
  }
  const areas = round.findings.filter((f) => req.findingIds?.includes(f.id)).map((f) => f.area);
  const issue = await ctx.github.createIssue(projectId, {
    title: req.title,
    body: [
      req.summary,
      "",
      "## Acceptance criteria",
      ...req.acceptanceCriteria.map((c) => `- [ ] ${c}`),
      "",
      `_Filed by the CodeDen dark factory's scout (${req.type}, ${req.priority} priority)._`,
    ].join("\n"),
    labels: [FACTORY_LABEL, TYPE_LABEL[req.type]],
  });
  const at = ctx.now().toISOString();
  const item = ctx.store.createItem({
    projectId,
    workKey: `issue:${issue.number}`,
    title: req.title,
    summary: req.summary,
    source: "discovery",
    area: areas[0] ?? null,
    acceptanceCriteria: req.acceptanceCriteria,
    stage: "backlog",
    type: req.type,
    classification: {
      type: req.type,
      confidence: "high",
      rationale: "Filed by the scout",
      by: "scout",
      at,
    },
    score: PRIORITY_SCORE[req.priority],
    issue,
  });
  const filed = round.filed + 1;
  ctx.store.saveLoop({ ...loop, scout: { ...loop.scout, round: { ...round, filed } } });
  return { itemId: item.id, issue: item.issue, filedThisRound: filed };
}
