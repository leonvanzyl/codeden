import { randomUUID } from "node:crypto";
import {
  type FactoryDigest,
  type FactoryItem,
  type FactoryLimits,
  type FactoryLoop,
  factoryNeed,
  factoryNeedLabel,
  type InboxItem,
  type Project,
} from "@codeden/contracts";
import type { InboxService } from "../inbox-service";
import { budgetSpend, type FactoryContext, factoryNotice, raiseInbox } from "./context";
import { prInboxIds } from "./merge";
import { localDay } from "./policy";
import { ownedPr } from "./pr-status";
import { recoverable } from "./recover";
import { OWNED_STAGES } from "./store";
import { DECISION_INBOX_PREFIX } from "./unattended";

/** Build, store and announce a day's digest: an inbox item and a notice to the orchestrator. */
export async function writeDigest(
  ctx: FactoryContext,
  inbox: InboxService,
  project: Project,
  loop: FactoryLoop,
  day: string,
): Promise<FactoryDigest> {
  const items = ctx.store.items(project.id).filter((i) => localDay(new Date(i.updatedAt)) === day);
  const digest = buildDigest({
    projectId: project.id,
    projectName: project.name,
    day,
    items,
    needsYou: needsYouItems(ctx, project.id),
    inbox: inbox.list({ projectId: project.id }),
    spend: budgetSpend(ctx, project.id, day, project.factoryLimits),
    limits: project.factoryLimits,
    pausedReason: loop.state === "paused" ? loop.pausedReason : null,
    now: ctx.now(),
  });
  ctx.store.saveDigest(digest);
  raiseInbox(ctx, {
    id: `inbox:factory-digest:${project.id}:${day}`,
    kind: "automation_result",
    notify: "factory",
    priority: "low",
    projectId: project.id,
    title: `Factory digest: ${project.name}, ${day} (${digest.shipped.length} shipped, ${digest.rejected.length} rejected, ${digest.waiting.length} waiting)`,
    body: digest.text,
  });
  factoryNotice(ctx, {
    id: `factory.digest:${digest.id}`,
    projectId: project.id,
    target: "orchestrator",
    event: "digest",
    title: `Factory digest for ${project.name} (${day})`,
    text: digest.text,
    wake: false,
  });
  return digest;
}

/**
 * Finished work that waits on a person, whenever it happened, by the definition the Factory
 * view's "Needs you" uses (`factoryNeed`): escalations, and failures with an open PR or from the
 * last day that the factory doesn't recover by itself.
 */
export function needsYouItems(ctx: FactoryContext, projectId: string): DigestNeed[] {
  const now = ctx.now().getTime();
  return ctx.store.items(projectId, OWNED_STAGES).flatMap((item) => {
    const open = ownedPr(ctx, item);
    const kind = factoryNeed(item, {
      now,
      ownsOpenPr: open !== null,
      recovering: recoverable(item),
    });
    if (!kind) return [];
    const need = factoryNeedLabel(kind, {
      attempts: item.attempts,
      prNumber: open?.number ?? null,
    });
    return [{ item, need }];
  });
}

/** An item that waits on a person, and what it needs. */
export interface DigestNeed {
  item: FactoryItem;
  need: string;
}

/**
 * The daily digest (§10.1 step 7): what shipped, what was rejected and why, spend against the
 * budget, and what is waiting on the user. Pure; the service stores it, raises the inbox item
 * and notifies the orchestrator.
 */
export function buildDigest(opts: {
  projectId: string;
  projectName: string;
  day: string;
  /** Items that changed during the day. */
  items: FactoryItem[];
  /** Finished items still waiting on a person, whenever they happened (`needsYouItems`). */
  needsYou: DigestNeed[];
  inbox: InboxItem[];
  spend: { usd: number; tokens: number };
  limits: FactoryLimits;
  pausedReason: string | null;
  now?: Date;
}): FactoryDigest {
  const shipped = opts.items
    .filter((i) => i.mergedAt !== null && dayOf(i.mergedAt) === opts.day)
    .map((i) => ({ itemId: i.id, title: i.title, pr: i.pr, reverted: i.stage === "reverted" }));
  const rejected = opts.items
    .filter((i) => i.stage === "rejected" || i.stage === "failed")
    .map((i) => ({
      itemId: i.id,
      title: i.title,
      stage: i.stage,
      reason: i.reason ?? (i.stage === "rejected" ? "Rejected by the PM" : "Merge checks failed"),
    }));
  // The inbox items about those items (ready, protected area, stuck) are listed with them.
  const listed = new Set(opts.needsYou.flatMap(({ item }) => prInboxIds(item.id)));
  const waiting = [
    ...opts.needsYou.map(({ item, need }) => ({
      title: `${item.title}: ${need}${item.reason ? ` (${item.reason})` : ""}`,
      inboxItemId: null,
      itemId: item.id,
    })),
    ...opts.inbox
      .filter(
        (x) =>
          x.status === "open" &&
          !listed.has(x.id) &&
          !x.id.startsWith("inbox:factory-digest:") &&
          // Decisions the factory made on its own are reported, not waiting (unless flagged).
          !(x.id.startsWith(DECISION_INBOX_PREFIX) && x.priority !== "high"),
      )
      .map((x) => ({ title: x.title, inboxItemId: x.id, itemId: null })),
  ];
  const decisions = opts.inbox
    .filter((x) => x.id.startsWith(DECISION_INBOX_PREFIX) && dayOf(x.createdAt) === opts.day)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((x) => ({
      title: x.title,
      decision: /\*\*Decision:\*\* (.*)/.exec(x.body ?? "")?.[1] ?? "",
      needsHuman: x.priority === "high",
      inboxItemId: x.id,
    }));
  const spend = {
    usd: Math.round(opts.spend.usd * 100) / 100,
    tokens: opts.spend.tokens,
    budgetUsd: opts.limits.dailyBudget.usd ?? null,
    budgetTokens: opts.limits.dailyBudget.tokens ?? null,
  };
  const digest: Omit<FactoryDigest, "text"> = {
    id: randomUUID(),
    projectId: opts.projectId,
    day: opts.day,
    shipped,
    rejected,
    spend,
    waiting,
    decisions,
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  return { ...digest, text: renderDigest(opts.projectName, digest, opts.pausedReason) };
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Markdown text of a digest (inbox body and orchestrator notice). */
export function renderDigest(
  projectName: string,
  d: Omit<FactoryDigest, "text">,
  pausedReason: string | null,
): string {
  const budget = [
    d.spend.budgetUsd !== null
      ? `$${d.spend.usd.toFixed(2)} of $${d.spend.budgetUsd.toFixed(2)}`
      : `$${d.spend.usd.toFixed(2)}`,
    d.spend.budgetTokens !== null
      ? `${d.spend.tokens} of ${d.spend.budgetTokens} tokens`
      : `${d.spend.tokens} tokens`,
  ].join(", ");
  const lines = [`Factory digest for ${projectName}, ${d.day}`, ""];
  if (pausedReason) lines.push(`The loop is paused: ${pausedReason}.`, "");
  lines.push(`Shipped (${d.shipped.length}):`);
  for (const s of d.shipped) {
    lines.push(
      `- ${s.title}${s.pr ? ` (#${s.pr.number} ${s.pr.url})` : ""}${s.reverted ? " (reverted)" : ""}`,
    );
  }
  if (d.shipped.length === 0) lines.push("- nothing");
  lines.push("", `Rejected or failed (${d.rejected.length}):`);
  for (const r of d.rejected) lines.push(`- ${r.title}: ${r.reason}`);
  if (d.rejected.length === 0) lines.push("- nothing");
  if (d.decisions.length > 0) {
    lines.push("", `Decided on its own (${d.decisions.length}):`);
    for (const x of d.decisions) {
      lines.push(`- ${x.title}${x.decision ? ` → ${x.decision}` : ""}`);
    }
  }
  lines.push("", `Spend: ${budget}`, "", `Waiting on you (${d.waiting.length}):`);
  for (const w of d.waiting) lines.push(`- ${w.title}`);
  if (d.waiting.length === 0) lines.push("- nothing");
  return lines.join("\n");
}
