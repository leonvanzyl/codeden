import { z } from "zod";
import { localDateTime } from "../../services/automations/cron";
import type { WakeupOwner } from "../../services/orchestration/reminders";
import { type AnyServerTool, defineTool, ToolError } from "../define";

/** The orchestrator, or the PM of the caller's project. */
function ownerOf(ctx: {
  role: string;
  projectId: string | null;
  sessionId: string | null;
}): WakeupOwner {
  if (ctx.role === "orchestrator") {
    return { target: "orchestrator", projectId: null, sessionId: ctx.sessionId };
  }
  if (!ctx.projectId) throw new ToolError("Only the orchestrator or a project's PM has wake-ups");
  return { target: "pm", projectId: ctx.projectId, sessionId: ctx.sessionId };
}

/** `schedule_wakeup` (§8.2): come back to something later without the user prompting. */
export const scheduleWakeup = defineTool({
  name: "schedule_wakeup",
  description:
    "Schedule a wake-up for yourself: at that time CodeDen wakes you with your note (and the usual status digest), so you can follow up later (check on running work, retry something, report back) without waiting for the user. Give inMinutes (1 to 10080) or an ISO 8601 time in at, no more than 7 days ahead. At most 20 pending at once.",
  roles: ["orchestrator", "pm"],
  scope: "session",
  alwaysLoad: true,
  input: z
    .object({
      inMinutes: z.int().min(1).max(10_080).optional(),
      at: z.iso.datetime({ offset: true }).optional().describe("When, e.g. 2026-11-11T09:00:00Z"),
      note: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .describe("What to do when you wake up, for your future self"),
    })
    .refine((v) => (v.inMinutes === undefined) !== (v.at === undefined), {
      message: "Give exactly one of inMinutes or at",
    }),
  handler: async ({ inMinutes, at, note }, ctx) => {
    const when = at ? new Date(at) : new Date(Date.now() + (inMinutes ?? 0) * 60_000);
    const reminder = ctx.services.orchestration.reminders.schedule(ownerOf(ctx), when, note);
    const tz = ctx.services.orchestration.timezone();
    return `Wake-up ${reminder.id} scheduled for ${reminder.notBefore} (${localDateTime(when, tz)} ${tz}, the user's local time). You will be woken with your note then; nothing more to do now.`;
  },
});

/** `list_wakeups`: the caller's pending wake-ups. */
export const listWakeups = defineTool({
  name: "list_wakeups",
  description: "Your pending wake-ups (from schedule_wakeup), soonest first.",
  roles: ["orchestrator", "pm"],
  scope: "session",
  input: z.object({}),
  handler: async (_input, ctx) => {
    const owner = ownerOf(ctx);
    const pending = ctx.services.orchestration.reminders.pending(owner.target, owner.projectId);
    const timezone = ctx.services.orchestration.timezone();
    return {
      timezone,
      wakeups: pending.flatMap((n) =>
        n.type === "reminder"
          ? [
              {
                id: n.id,
                at: n.notBefore,
                local: n.notBefore ? localDateTime(new Date(n.notBefore), timezone) : null,
                note: n.data.note,
              },
            ]
          : [],
      ),
    };
  },
});

/** `cancel_wakeup`: drop one of the caller's pending wake-ups. */
export const cancelWakeup = defineTool({
  name: "cancel_wakeup",
  description: "Cancel one of your pending wake-ups by its id (from list_wakeups).",
  roles: ["orchestrator", "pm"],
  scope: "session",
  input: z.object({ id: z.string().min(1) }),
  handler: async ({ id }, ctx) => {
    const owner = ownerOf(ctx);
    if (!ctx.services.orchestration.reminders.cancel(owner.target, owner.projectId, id)) {
      throw new ToolError(`You have no pending wake-up ${id}. Call list_wakeups for the ids.`);
    }
    return `Wake-up ${id} cancelled.`;
  },
});

/** The wake-up tools of the orchestrator and PMs. */
export const wakeupTools: AnyServerTool[] = [scheduleWakeup, listWakeups, cancelWakeup];
