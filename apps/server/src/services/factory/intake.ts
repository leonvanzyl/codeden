import type {
  Classification,
  FactoryItem,
  FactoryLoop,
  Project,
  WorkType,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { classifyIssue, TYPE_LABEL } from "./classify";
import type { FactoryContext } from "./context";
import { slugify } from "./policy";
import { isTrustedAuthor, trustedLogins } from "./trust";

/**
 * Intake and "Identify type" (§10.1): issues opened on GitHub become work items. Issues by
 * trusted authors are classified as a bug, a feature or a docs change and queued for an agent;
 * issues by anyone else are listed as ignored and nothing runs on them (no model call either)
 * until a person lets them in. A failed check on the default branch becomes a bug by itself.
 */

/** Label on issues the factory created or took on. */
export const FACTORY_LABEL = "codeden-factory";

/** Classifications per tick (each may call the utility model). */
const CLASSIFY_PER_TICK = 3;

/** What each pipeline does next, for the comment on the issue. */
const NEXT_STEPS: Record<WorkType, string> = {
  bug: "Reproduce → Create fix → Review fix → Merge",
  feature: "Analyze → Implement → Review → Merge",
  docs: "Implement docs change → Merge",
};

/** A work key for an item without an issue yet. */
export function candidateWorkKey(title: string): string {
  return `factory:${slugify(title)}`;
}

/**
 * New issues (opened after the factory was switched on, or labelled for it) become items:
 * trusted ones wait to be classified, untrusted ones are ignored. While the account CodeDen
 * uses on GitHub is unknown, issues by authors not listed by name wait for the next tick
 * rather than being ignored by mistake.
 */
export async function intakeIssues(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const items = ctx.store.items(project.id);
  const known = new Set(items.flatMap((i) => (i.issue ? [i.issue.number] : [])));
  // GitHub timestamps have second precision and clocks drift: allow a minute of slack.
  const since = loop.enabledAt ? Date.parse(loop.enabledAt) - 60_000 : Number.POSITIVE_INFINITY;
  const openIssues = ctx.github.openIssues(project.id);
  const open = new Set(openIssues.map((i) => i.number));
  const fresh = openIssues.filter((issue) => {
    if (known.has(issue.number)) return false;
    const opened = issue.createdAt ? Date.parse(issue.createdAt) : 0;
    return issue.labels.includes(FACTORY_LABEL) || opened >= since;
  });
  const ignored = items.filter((i) => i.stage === "ignored");
  if (fresh.length === 0 && ignored.length === 0) return loop;
  const viewer = await ctx.github.viewerLogin().catch(() => null);
  const trusted = trustedLogins(project.factoryLimits, viewer);

  for (const issue of fresh.sort((a, b) => a.number - b.number)) {
    const ok = isTrustedAuthor(issue.author, trusted);
    if (!ok && viewer === null) continue;
    const by = issue.author ? `@${issue.author}` : "an unknown author";
    ctx.store.createItem({
      projectId: project.id,
      workKey: `issue:${issue.number}`,
      title: issue.title,
      summary: (issue.body ?? "").slice(0, 8_000),
      source: "issue",
      stage: ok ? "candidate" : "ignored",
      trust: ok ? "trusted" : "untrusted",
      author: issue.author,
      issue: { number: issue.number, url: issue.url, title: issue.title },
      reason: ok ? null : `Opened by ${by}, who is not a trusted author`,
    });
  }

  // Someone added the author to the trusted list since, or the issue was closed meanwhile.
  for (const item of ignored) {
    const closed =
      item.issue !== null &&
      !open.has(item.issue.number) &&
      ctx.github.issue(project.id, item.issue.number)?.state === "closed";
    if (closed) {
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        stage: "rejected",
        reason: "The issue was closed on GitHub",
        finishedAt: ctx.now().toISOString(),
      }));
    } else if (isTrustedAuthor(item.author, trusted)) {
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        stage: "candidate",
        trust: "trusted",
        reason: null,
        note: `@${i.author} is now a trusted author`,
      }));
    }
  }
  return loop;
}

/** Classify waiting items (oldest first, a few per tick) and queue them for an agent. */
export async function classifyPending(ctx: FactoryContext, project: Project): Promise<void> {
  const pending = ctx.store
    .items(project.id, ["candidate"])
    .filter((i) => i.trust !== "untrusted")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, CLASSIFY_PER_TICK);
  for (const item of pending) {
    try {
      await classifyOne(ctx, project, item);
    } catch (error) {
      ctx.log?.(`factory: classify ${item.id}: ${errorMessage(error)}`);
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        note: `Classification failed: ${errorMessage(error)}`,
      }));
    }
  }
}

async function classifyOne(ctx: FactoryContext, project: Project, item: FactoryItem) {
  const labels = item.issue ? (ctx.github.issue(project.id, item.issue.number)?.labels ?? []) : [];
  const classification = await classifyIssue(
    { title: item.title, body: item.summary, labels },
    (system, prompt) => ctx.complete("factory classification", system, prompt),
    ctx.now(),
  );
  const { type } = classification;
  const issue = item.issue ?? (await createIssueFor(ctx, project, item, type));
  const updated = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "backlog",
    type,
    classification,
    issue,
    workKey: issue ? `issue:${issue.number}` : i.workKey,
    note: null,
  }));
  // A new issue already says what it is; an existing one hears it in a comment.
  if (item.issue) await announceType(ctx, project.id, updated, classification);
}

/** Label the issue with its type and say on it which pipeline it goes down. */
export async function announceType(
  ctx: FactoryContext,
  projectId: string,
  item: FactoryItem,
  classification: Classification,
): Promise<void> {
  if (!item.issue) return;
  const { type } = classification;
  await ctx.github
    .labelIssue(projectId, item.issue.number, [FACTORY_LABEL, TYPE_LABEL[type]])
    .catch(() => undefined);
  const why: Record<Classification["by"], string> = {
    label: "from its label",
    model: `${classification.confidence} confidence`,
    heuristic: "from its wording",
    scout: "by the scout",
    system: "by CodeDen",
    user: "by a maintainer",
    pm: "by the project manager",
  };
  await ctx.github
    .comment(
      projectId,
      item.issue.number,
      [
        `**CodeDen software factory**: classified as a **${type}** (${why[classification.by]}). ${classification.rationale}`,
        "",
        `Next: ${NEXT_STEPS[type]}.${item.trust === "admitted" ? " This issue was let in by hand, so a person merges the result." : ""}`,
      ].join("\n"),
    )
    .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
}

/** Items without an issue (from before 0.6) get one, so all work is traceable on GitHub. */
async function createIssueFor(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  type: WorkType,
) {
  const criteria = item.acceptanceCriteria;
  return ctx.github
    .createIssue(project.id, {
      title: item.title,
      body: [
        item.summary,
        ...(criteria.length
          ? ["", "## Acceptance criteria", ...criteria.map((c) => `- [ ] ${c}`)]
          : []),
        "",
        `_Filed by the CodeDen factory (${item.source}). Pipeline: ${NEXT_STEPS[type]}._`,
        `<!-- codeden:factory item=${item.id} -->`,
      ].join("\n"),
      labels: [FACTORY_LABEL, TYPE_LABEL[type]],
    })
    .catch((error: unknown) => {
      ctx.log?.(`factory: creating the issue for ${item.id}: ${errorMessage(error)}`);
      return null;
    });
}

/** A failed check on the default branch becomes a bug, already reproduced (once per commit). */
export async function intakeFailedChecks(
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
  const at = ctx.now().toISOString();
  const title = `Fix failing ${failing} on the default branch`.slice(0, 200);
  const criteria = [`${failing} passes on the default branch`];
  const issue = await ctx.github
    .createIssue(project.id, {
      title,
      body: [
        `Checks fail on \`${head.sha}\`: ${failing}.`,
        "",
        "## Acceptance criteria",
        ...criteria.map((c) => `- [ ] ${c}`),
        "",
        `_Found by the CodeDen factory. Pipeline: ${NEXT_STEPS.bug}._`,
      ].join("\n"),
      labels: [FACTORY_LABEL, TYPE_LABEL.bug],
    })
    .catch(() => null);
  ctx.store.createItem({
    projectId: project.id,
    workKey: issue ? `issue:${issue.number}` : `factory:fix-main-${head.sha.slice(0, 7)}`,
    title,
    summary: `Checks failing on ${head.sha}: ${failing}.`,
    source: "failed_check",
    area: "bugs",
    acceptanceCriteria: criteria,
    stage: "backlog",
    type: "bug",
    classification: {
      type: "bug",
      confidence: "high",
      rationale: "A check fails on the default branch.",
      by: "system",
      at,
    },
    investigation: {
      kind: "reproduction",
      outcome: "reproduced",
      summary: `${failing} fails on the default branch (${head.sha.slice(0, 7)}).`,
      details: `Run ${failing} on the default branch and read its log.`,
      testPath: null,
      at,
    },
    issue,
    score: 0.9,
  });
  return { ...loop, seenFailedShas: [...loop.seenFailedShas, head.sha].slice(-20) };
}
