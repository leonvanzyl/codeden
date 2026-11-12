import {
  ConflictDecision,
  messageFrom,
  ProviderId,
  ReasoningEffort,
  SessionStatus,
  StartedBy,
  StartSessionRequest,
  WorkKey,
} from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";
import { agentSessionOf, compactSession, compactWork, projectFor } from "../shared/helpers";

const ENDED = new Set(["completed", "failed", "stopped"]);

/** `list_sessions` (§8.4, always loaded): the project's agent sessions. */
export const listSessions = defineTool({
  name: "list_sessions",
  description:
    "List this project's agent sessions, newest first, with work key, purpose, status, progress and result. Filter by status, workKey or who started them. Ended sessions (completed, failed, stopped) are left out unless includeEnded is true or you filter by status.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    status: z.array(SessionStatus).optional(),
    workKey: z.string().min(1).optional(),
    startedBy: StartedBy.shape.kind.optional(),
    includeEnded: z.boolean().optional(),
    limit: z.int().min(1).max(100).optional(),
  }),
  handler: async (input, { services, projectId }) => {
    const list = services.sessionRepo
      .list({ projectId, role: "agent", workKey: input.workKey, status: input.status })
      .filter((s) => !input.startedBy || s.startedBy.kind === input.startedBy)
      .filter((s) => input.status || input.includeEnded || !ENDED.has(s.status))
      .slice(0, input.limit ?? 20);
    return { count: list.length, sessions: list.map(compactSession) };
  },
});

/** `start_session` (§8.2, §8.4): start an agent session, with the conflict check built in. */
export const startSession = defineTool({
  name: "start_session",
  description:
    "Start an agent session in its own worktree to do one piece of work. Always pass a workKey (issue:<n>, pr:<n>, automation:<name> or request:<slug>) and a one-line purpose; add scope (paths or area) when known. If matching work is already running or queued, nothing starts and the result is 'conflict' with the existing work: choose the resolution yourself and call again with conflict = {resolution: 'wait'} (queue behind it), {resolution: 'skip'} (it is the same work), {resolution: 'join', sessionId} (send the prompt to the existing session) or {resolution: 'force', reason}.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe(
        "The brief for the agent: goal, context, acceptance criteria, and the decisions you already made (defaults, scope, whether to open a pull request), so the agent doesn't have to ask",
      ),
    purpose: z.string().trim().min(1).max(300),
    workKey: WorkKey.optional(),
    scope: z
      .object({ paths: z.array(z.string()).optional(), area: z.string().optional() })
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    issueNumber: z.int().positive().optional(),
    provider: ProviderId.optional(),
    model: z.string().min(1).optional(),
    effort: ReasoningEffort.optional(),
    conflict: ConflictDecision.optional(),
    reportTo: z
      .enum(["orchestrator"])
      .optional()
      .describe(
        "'orchestrator' when the orchestrator passed this work on: its finish or failure also reaches the orchestrator, so it can tell the user",
      ),
  }),
  handler: async (input, { services, projectId, sessionId }) => {
    const project = projectFor(services, projectId);
    const issue =
      input.issueNumber && project.kind === "github"
        ? {
            number: input.issueNumber,
            url: `https://github.com/${project.github.owner}/${project.github.repo}/issues/${input.issueNumber}`,
          }
        : undefined;
    const req = StartSessionRequest.parse({
      projectId,
      role: "agent",
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      purpose: input.purpose,
      workKey: input.workKey ?? (input.issueNumber ? `issue:${input.issueNumber}` : undefined),
      scope: input.scope,
      title: input.title,
      issue,
      startedBy: { kind: "pm", id: sessionId ?? undefined, reportTo: input.reportTo },
      parentSessionId: sessionId ?? undefined,
      // The brief is the session's first message: no sender line, but the transcript shows
      // it as the PM's.
      input: { text: input.prompt, from: "pm" },
      conflict: input.conflict,
    });
    const result = await services.sessions.start(req);
    switch (result.status) {
      case "started":
        return { status: "started", sessionId: result.sessionId };
      case "queued":
        return { status: "queued", sessionId: result.sessionId, behind: result.behind };
      case "skipped":
        return { status: "skipped", message: "Nothing was started." };
      case "joined":
        return {
          status: "joined",
          sessionId: result.sessionId,
          message: "Sent to the existing session.",
        };
      case "conflict":
        return {
          status: "conflict",
          message:
            "Matching work is already running or queued; nothing was started. Choose a resolution yourself and call start_session again with it: wait (queue behind it), skip (it is the same work), join with sessionId (it adds to that work) or force with a reason. Then say in one line what you chose.",
          existing: result.existing.map(compactWork),
        };
    }
  },
});

/** `message_session` (§8.2): follow up with one of the project's agents. */
export const messageSession = defineTool({
  name: "message_session",
  description:
    "Send a message to one of this project's agent sessions (follow-up, correction, answer). Queued while it is busy unless whenBusy is 'steer' (inject into the running turn).",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({
    sessionId: z.string().min(1),
    text: z.string().min(1).max(50_000),
    whenBusy: z.enum(["queue", "steer"]).optional(),
  }),
  handler: async ({ sessionId, text, whenBusy }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    const res = await services.sessions.send(
      session.id,
      {
        input: messageFrom("pm", text),
        whenBusy: whenBusy ?? "queue",
      },
      "pm",
    );
    return `Message ${res.status}.`;
  },
});

/** `stop_session` (§8.4, always loaded): stop one of the project's agents. */
export const stopSession = defineTool({
  name: "stop_session",
  description:
    "Stop one of this project's agent sessions (it can be resumed later). Use it for duplicates, runaway work or work that is no longer wanted; say why in reason.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: z.object({ sessionId: z.string().min(1), reason: z.string().max(500).optional() }),
  handler: async ({ sessionId }, { services, projectId }) => {
    const session = agentSessionOf(services, sessionId, projectId);
    if (ENDED.has(session.status))
      throw new ToolError(`Session ${session.id} already ${session.status}`);
    const stopped = await services.sessions.stop(session.id);
    return { status: stopped.status, sessionId: session.id };
  },
});
