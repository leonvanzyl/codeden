import { z } from "zod";
import { StartSessionResponse } from "./api";
import { AutonomyLevel, Id, ProviderId, QuietHours, ReasoningEffort, Timestamp } from "./common";
import {
  Automation,
  AutomationAction,
  AutomationGuards,
  AutomationRun,
  AutomationRunStatus,
  AutomationTarget,
  AutomationTrigger,
  TriagePolicy,
} from "./entities/automation";
import { InboxItem } from "./entities/inbox";
import { TriageDecision } from "./github";
import { ConflictDecision, OverlapPolicy, ScheduledRun, WorkSummary } from "./work";

/**
 * Automations HTTP API (§10): definitions from built-in templates, `~/.codeden/automations/`,
 * a repo's `.codeden/automations/` and the database; their per-project schedule state, runs,
 * manual runs with the §8.4 conflict result, the starter set and issue triage decisions.
 */

/**
 * Some guards, without defaults: only the fields given override a template's or the current
 * guards (`AutomationGuards.partial()` would fill in every default).
 */
export const AutomationGuardsPatch = z.object({
  overlapPolicy: OverlapPolicy.optional(),
  maxConcurrent: z.int().positive().optional(),
  maxPerDay: z.int().positive().nullable().optional(),
  quietHours: QuietHours.nullable().optional(),
  catchUpMissed: z.boolean().optional(),
});
export type AutomationGuardsPatch = z.infer<typeof AutomationGuardsPatch>;

/** The action kinds a Markdown automation file can declare (`action:` in the frontmatter). */
export const AutomationFileAction = z.enum(["start_session", "message_pm", "triage"]);
export type AutomationFileAction = z.infer<typeof AutomationFileAction>;

/**
 * Frontmatter of an automation Markdown file (built-in templates, global and project files).
 * The Markdown body is the prompt (`start_session`) or the message (`message_pm`).
 */
export const AutomationFileFrontmatter = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: AutomationTrigger,
  action: AutomationFileAction.default("start_session"),
  /** Work key of the runs; `automation:<file name>` when omitted. */
  workKey: z.string().min(1).max(200).optional(),
  title: z.string().optional(),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  effort: ReasoningEffort.optional(),
  autonomy: AutonomyLevel.optional(),
  guards: AutomationGuardsPatch.optional(),
  /** Triage policy (`action: triage` only). */
  policy: TriagePolicy.optional(),
  /** Part of the starter set offered to new projects (templates only). */
  starter: z.boolean().default(false),
  /** Needs a GitHub project (issues, PRs); hidden from the starter set of local projects. */
  requiresGithub: z.boolean().default(false),
});
export type AutomationFileFrontmatter = z.infer<typeof AutomationFileFrontmatter>;

/** A template an automation can be created from: built in, or a global automation file. */
export const AutomationTemplate = z.object({
  /** File name without `.md`, e.g. `security-audit`. */
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  source: z.enum(["builtin", "global_file"]),
  path: z.string().nullable(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  guards: AutomationGuards,
  workKey: z.string(),
  starter: z.boolean(),
  requiresGithub: z.boolean(),
});
export type AutomationTemplate = z.infer<typeof AutomationTemplate>;

/** Schedule state of an automation in one project. */
export const AutomationState = z.object({
  projectId: Id,
  /** Effective: global switch, project switch, the automation and any per-project override. */
  enabled: z.boolean(),
  /** Per-project override of `enabled` for automations that target all projects. */
  enabledOverride: z.boolean().nullable(),
  /** Paused by the PM or the user (`pause_automation`): no cron or event runs. */
  paused: z.boolean(),
  /** Next cron occurrence; null for event and manual triggers or when not scheduled. */
  nextRunAt: Timestamp.nullable(),
  /** The occurrence `skip_next_run` will skip. */
  skipNextAt: Timestamp.nullable(),
});
export type AutomationState = z.infer<typeof AutomationState>;

/** An automation with its per-project state and latest run. */
export const AutomationListItem = z.object({
  automation: Automation,
  states: z.array(AutomationState),
  /**
   * The newest run: in the listed project when the list is scoped to one (`projectId`), else
   * across every project. Null when there is none.
   */
  lastRun: AutomationRun.nullable(),
  /** Source file for file-based automations. */
  path: z.string().nullable(),
  /** File-based automations are edited in their file; only enable/disable applies here. */
  readOnly: z.boolean(),
});
export type AutomationListItem = z.infer<typeof AutomationListItem>;

/** A Markdown automation file that failed to parse. */
export const AutomationFileError = z.object({ path: z.string(), message: z.string() });
export type AutomationFileError = z.infer<typeof AutomationFileError>;

/** `GET /api/automations?projectId=`. */
export const ListAutomationsQuery = z.object({ projectId: Id.optional() });
export type ListAutomationsQuery = z.infer<typeof ListAutomationsQuery>;

export const AutomationListResponse = z.object({
  automations: z.array(AutomationListItem),
  errors: z.array(AutomationFileError),
});
export type AutomationListResponse = z.infer<typeof AutomationListResponse>;

/**
 * `POST /api/automations`: from a template (`templateId`, fields override it) or from scratch
 * (`name`, `trigger`, `action`). `projectId` targets one project; omitted, all projects.
 * Created disabled unless `enabled` is true.
 */
export const CreateAutomationRequest = z
  .object({
    templateId: z.string().min(1).optional(),
    projectId: Id.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    trigger: AutomationTrigger.optional(),
    action: AutomationAction.optional(),
    guards: AutomationGuardsPatch.optional(),
    workKey: z.string().min(1).max(200).optional(),
    enabled: z.boolean().default(false),
  })
  .refine((r) => r.templateId !== undefined || (r.name && r.trigger && r.action), {
    message: "Pass templateId, or name, trigger and action",
  });
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

/** `PATCH /api/automations/:id` (database automations only). */
export const UpdateAutomationRequest = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  trigger: AutomationTrigger.optional(),
  action: AutomationAction.optional(),
  target: AutomationTarget.optional(),
  guards: AutomationGuardsPatch.optional(),
  workKey: z.string().min(1).max(200).nullable().optional(),
});
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

/**
 * `POST /api/automations/:id/enable|disable`. With `projectId` on an all-projects automation,
 * sets that project's override; otherwise the automation's own switch.
 */
export const SetAutomationEnabledRequest = z.object({ projectId: Id.optional() });
export type SetAutomationEnabledRequest = z.infer<typeof SetAutomationEnabledRequest>;

/** `POST /api/automations/:id/pause|resume|skip-next|unskip-next`. */
export const AutomationProjectRequest = z.object({ projectId: Id });
export type AutomationProjectRequest = z.infer<typeof AutomationProjectRequest>;

/** `POST /api/automations/:id/skip-next`: the occurrence now skipped (null: none scheduled). */
export const SkipNextResponse = z.object({ skipped: ScheduledRun.nullable() });
export type SkipNextResponse = z.infer<typeof SkipNextResponse>;

/**
 * `POST /api/automations/:id/unskip-next`: undo a skip; the next occurrence, which runs again
 * (null when nothing was skipped).
 */
export const UnskipNextResponse = z.object({ next: ScheduledRun.nullable() });
export type UnskipNextResponse = z.infer<typeof UnskipNextResponse>;

/** `POST /api/automations/:id/run`: run now, with the §8.4 conflict check. */
export const RunAutomationRequest = z.object({
  projectId: Id,
  /** The caller's decision when a previous attempt returned `conflict`. */
  conflict: ConflictDecision.optional(),
  /** Extra `{{placeholders}}` for the prompt. */
  context: z.record(z.string(), z.string()).optional(),
});
export type RunAutomationRequest = z.infer<typeof RunAutomationRequest>;

/** Result of a manual, scheduled or event run. On `conflict` nothing was recorded. */
export const RunAutomationResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), run: AutomationRun, sessionId: Id.nullable() }),
  z.object({
    status: z.literal("queued"),
    run: AutomationRun,
    sessionId: Id,
    behind: z.array(Id),
  }),
  z.object({ status: z.literal("conflict"), existing: z.array(WorkSummary).min(1) }),
  z.object({ status: z.literal("skipped"), run: AutomationRun }),
  z.object({ status: z.literal("joined"), sessionId: Id }),
]);
export type RunAutomationResponse = z.infer<typeof RunAutomationResponse>;

/** `GET /api/automations/runs`. */
export const ListAutomationRunsQuery = z.object({
  projectId: Id.optional(),
  automationId: Id.optional(),
  status: AutomationRunStatus.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListAutomationRunsQuery = z.infer<typeof ListAutomationRunsQuery>;

/** `GET /api/automations/upcoming` (the Now / Next strip). */
export const UpcomingRunsQuery = z.object({
  projectId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type UpcomingRunsQuery = z.infer<typeof UpcomingRunsQuery>;

/** `POST /api/projects/:id/automations/starter`: create (and optionally enable) the starter set. */
export const StarterSetRequest = z.object({ enable: z.boolean().default(false) });
export type StarterSetRequest = z.infer<typeof StarterSetRequest>;

export const StarterSetResponse = z.object({ automations: z.array(Automation) });
export type StarterSetResponse = z.infer<typeof StarterSetResponse>;

/** A project's automation switch (`GET|PATCH /api/projects/:id/automations/settings`). */
export const AutomationProjectSettings = z.object({
  projectId: Id,
  enabled: z.boolean(),
  updatedAt: Timestamp.nullable(),
});
export type AutomationProjectSettings = z.infer<typeof AutomationProjectSettings>;

export const UpdateAutomationProjectSettingsRequest = z.object({ enabled: z.boolean() });
export type UpdateAutomationProjectSettingsRequest = z.infer<
  typeof UpdateAutomationProjectSettingsRequest
>;

/** The PM's `report_triage`: the decision it applied to a new issue. */
export const TriageReport = z.object({
  issueNumber: z.int().positive(),
  decision: TriageDecision,
  /** Two or three sentences: what the issue asks and why this decision. */
  summary: z.string().trim().min(1).max(2000),
  duplicateOf: z.int().positive().optional(),
});
export type TriageReport = z.infer<typeof TriageReport>;

/** What happened after a triage report. */
export const TriageReportResult = z.discriminatedUnion("status", [
  /** Not `ready`: labels and comment were the whole job. */
  z.object({ status: z.literal("recorded") }),
  /** `ready` and policy allowed starting without asking. */
  z.object({ status: z.literal("started"), start: StartSessionResponse }),
  /** `ready`, waiting on the user's "Should I take this on?" decision. */
  z.object({ status: z.literal("inbox"), inboxItemId: Id }),
]);
export type TriageReportResult = z.infer<typeof TriageReportResult>;

/** `POST /api/automations/triage/:inboxItemId/accept|decline`. */
export const TriageDecisionRequest = z.object({
  reason: z.string().trim().max(2000).optional(),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  /** Decision when accepting returned `conflict`. */
  conflict: ConflictDecision.optional(),
});
export type TriageDecisionRequest = z.infer<typeof TriageDecisionRequest>;

export const TriageDecisionResponse = z.object({
  item: InboxItem,
  /** The session start when accepted (possibly `conflict`); null when declined. */
  start: StartSessionResponse.nullable(),
});
export type TriageDecisionResponse = z.infer<typeof TriageDecisionResponse>;
