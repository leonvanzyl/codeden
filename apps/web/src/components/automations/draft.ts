import {
  type Automation,
  AutomationGuards,
  type AutomationTemplate,
  type AutonomyLevel,
  type ItemRecord,
  type Session,
  splitSender,
  type UpdateAutomationRequest,
} from "@codeden/contracts";
import type { CreateAutomationInput } from "@/lib/api/automations-api";
import { cronError } from "@/lib/cron";
import { actionText } from "./action-editor";

/** What the automation editor edits: everything but the id, switch and history. */
export interface AutomationDraft {
  name: string;
  description: string | null;
  /** This project, or every project. */
  target: "project" | "all_projects";
  trigger: Automation["trigger"];
  action: Automation["action"];
  guards: Automation["guards"];
  workKey?: string;
}

/** A new automation: weekdays at 09:00, an agent session with the default permissions. */
export function blankDraft(autonomy: AutonomyLevel): AutomationDraft {
  return {
    name: "",
    description: null,
    target: "project",
    trigger: { type: "cron", expression: "0 9 * * 1-5" },
    action: { type: "start_session", prompt: "", autonomy },
    guards: AutomationGuards.parse({}),
  };
}

/** A template, ready to tweak before saving. */
export function draftFromTemplate(t: AutomationTemplate, autonomy: AutonomyLevel): AutomationDraft {
  const action =
    t.action.type === "start_session" && !t.action.autonomy ? { ...t.action, autonomy } : t.action;
  return {
    name: t.name,
    description: t.description,
    target: "project",
    trigger: t.trigger,
    action,
    guards: t.guards,
    workKey: t.workKey,
  };
}

/**
 * The text of a session's opening message: the first user message of its root thread, without
 * attachments and without the line naming a PM or orchestrator sender. Empty when it has none.
 */
export function openingPrompt(session: Session, items: readonly ItemRecord[]): string {
  let first: ItemRecord | undefined;
  for (const r of items) {
    if (r.threadId !== session.rootThreadId || r.item.kind !== "user_message") continue;
    if (!first || r.position < first.position) first = r;
  }
  if (first?.item.kind !== "user_message") return "";
  return splitSender(first.item.input.text, first.item.input.from).text;
}

/**
 * A session made repeatable: its opening message as the prompt, its agent and permissions as
 * the session action, its title as the name, run only by hand until the user picks a schedule.
 */
export function draftFromSession(session: Session, items: readonly ItemRecord[]): AutomationDraft {
  const name = (session.title ?? session.purpose).trim();
  return {
    name,
    description: null,
    target: "project",
    trigger: { type: "manual" },
    action: {
      type: "start_session",
      prompt: openingPrompt(session, items),
      ...(name ? { title: name } : {}),
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      autonomy: session.autonomy,
    },
    guards: AutomationGuards.parse({}),
  };
}

export function draftFromAutomation(a: Automation): AutomationDraft {
  return {
    name: a.name,
    description: a.description,
    target: a.target.type,
    trigger: a.trigger,
    action: a.action,
    guards: a.guards,
    workKey: a.workKey,
  };
}

/** Why the draft cannot be saved yet, in plain words; empty when it can. */
export function draftProblems(d: AutomationDraft, timezone: string): string[] {
  const out: string[] = [];
  if (!d.name.trim()) out.push("Give it a name.");
  if (d.trigger.type === "cron") {
    const tz = d.trigger.timezone || timezone;
    if (cronError(d.trigger.expression.trim(), tz)) out.push("Fix the schedule.");
  }
  if (d.action.type !== "triage" && !actionText(d.action).trim()) {
    out.push(d.action.type === "start_session" ? "Write the prompt." : "Write the message.");
  }
  if (d.action.type === "triage" && d.trigger.type !== "event") {
    out.push("Triage runs when an issue event happens.");
  }
  return out;
}

const clean = (d: AutomationDraft): AutomationDraft => ({
  ...d,
  name: d.name.trim(),
  description: d.description?.trim() || null,
  trigger:
    d.trigger.type === "cron"
      ? { ...d.trigger, expression: d.trigger.expression.trim() }
      : d.trigger,
});

export function toCreateRequest(
  draft: AutomationDraft,
  projectId: string,
  enabled: boolean,
): CreateAutomationInput {
  const d = clean(draft);
  return {
    ...(d.target === "project" ? { projectId } : {}),
    name: d.name,
    description: d.description,
    trigger: d.trigger,
    action: d.action,
    guards: d.guards,
    ...(d.workKey ? { workKey: d.workKey } : {}),
    enabled,
  };
}

export function toUpdateRequest(
  draft: AutomationDraft,
  projectId: string,
): UpdateAutomationRequest {
  const d = clean(draft);
  return {
    name: d.name,
    description: d.description,
    trigger: d.trigger,
    action: d.action,
    guards: d.guards,
    target: d.target === "project" ? { type: "project", projectId } : { type: "all_projects" },
    workKey: d.workKey ?? null,
  };
}
