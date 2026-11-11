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
import { freeSlots, slugify } from "./policy";
import { lensPrompt } from "./prompts-scout";
import { defaultBranch, knownTitles } from "./scout";
import { ACTIVE_STAGES, WAITING_STAGES } from "./store";

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
  const allowed = new Set(loop.tuning.areas);
  const seen = new Set<DiscoveryArea>();
  const wanted = req.lenses.filter((l) => {
    if (!allowed.has(l.area) || seen.has(l.area)) return false;
    seen.add(l.area);
    return true;
  });
  const cap = Math.min(
    loop.tuning.discoveryPerRound,
    freeSlots(ctx.sessions.activeCount(projectId), project.factoryLimits),
  );
  const at = ctx.now().toISOString();
  const lensSessions = { ...loop.scout.lensSessions };
  const started: ScoutLensRun[] = [];
  for (const lens of wanted.slice(0, cap)) {
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
        if (res.status !== "started" && res.status !== "queued") continue;
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
  const skipped = wanted.length - started.length + (req.lenses.length - wanted.length);
  const note =
    skipped > 0 ? ` ${skipped} review area request(s) were over the limit or not allowed.` : "";
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
