import { AREA_LABEL } from "@/components/factory/meta";
import type { AgentRole, AgentStatus, AgentStep, BlockedOn, SceneAgent } from "./agents";

/**
 * What the pixel card says about an agent on hover or keyboard focus (#264): its role, the item
 * with its issue and PR number, the step, provider and model, the latest progress line, the time
 * in this step and a plain status. Pure, so each role's and step's card is unit-tested; the
 * component only lays it out. The same facts name the agent's button for screen readers.
 */

export const ROLE_LABEL: Record<AgentRole, string> = {
  builder: "Builder",
  reviewer: "Reviewer",
  rebaser: "Rebaser",
  integrator: "Integrator",
  scout: "Scout",
  area: "Area reviewer",
  pm: "Project manager",
};

export const STEP_LABEL: Record<AgentStep, string> = {
  reproducing: "Reproducing",
  analyzing: "Analyzing",
  implementing: "Implementing",
  revising: "Revising",
  reviewing: "Reviewing",
  rebasing: "Rebasing",
  merging: "Merging",
  watching_ci: "Watching CI",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  thinking: "Thinking",
  approval: "Waiting for approval",
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
};

const BLOCKED_LABEL: Record<BlockedOn, string> = {
  ci: "waits for CI",
  conflicts: "merge conflicts to resolve",
  agent: "waits for a free agent",
  turn: "waits its turn to merge",
  person: "waits on a person",
  failed: "its session failed",
  cut_off: "its session was cut off",
};

export interface AgentCardModel {
  role: string;
  /** "#142 · PR #57", or null for agents without an item. */
  refs: string | null;
  /** The item's title, or null. */
  title: string | null;
  step: string;
  /** "Claude Code · opus", or "No session yet". */
  model: string;
  progress: string | null;
  /** Time in this step ("12 min"), or null when unknown. */
  inStep: string | null;
  status: string;
  statusKind: AgentStatus;
}

/** A step's length in a few characters: "under a minute", "12 min", "2 h 5 min", "3 days". */
export function stepTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

function stepOf(a: SceneAgent): string {
  if (!a.step) return a.activity ?? "—";
  const queued = a.step === "merging" ? a.card?.pr?.queuePosition : null;
  return queued ? `${STEP_LABEL[a.step]} (number ${queued} in line)` : STEP_LABEL[a.step];
}

export function agentCard(a: SceneAgent, now: number): AgentCardModel {
  const w = a.card?.item;
  const pr = a.card?.pr?.pr ?? w?.pr ?? w?.ownedPr ?? null;
  const refs = w
    ? [w.issue ? `#${w.issue.number}` : null, pr ? `PR #${pr.number}` : null]
        .filter(Boolean)
        .join(" · ") || null
    : null;
  const since = a.since ? Date.parse(a.since) : Number.NaN;
  return {
    role:
      a.role === "area" && a.area
        ? `${ROLE_LABEL.area} · ${AREA_LABEL[a.area]}`
        : ROLE_LABEL[a.role],
    refs,
    title: w?.title ?? null,
    step: stepOf(a),
    model: [a.provider, a.model].filter(Boolean).join(" · ") || "No session yet",
    progress: a.progress,
    inStep: Number.isNaN(since) ? null : stepTime(Math.max(0, now - since)),
    status:
      a.status === "blocked" && a.blockedOn
        ? `${STATUS_LABEL.blocked}: ${BLOCKED_LABEL[a.blockedOn]}`
        : STATUS_LABEL[a.status],
    statusKind: a.status,
  };
}

/** The card in one line, for the agent's button: "Builder, #142 · PR #57 Fix the flake, …". */
export function agentLabel(card: AgentCardModel): string {
  const what = [card.refs, card.title].filter(Boolean).join(" ");
  return [card.role, what || null, card.step, card.status].filter(Boolean).join(", ");
}
