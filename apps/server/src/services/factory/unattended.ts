import { randomUUID } from "node:crypto";
import type {
  FactoryDecisionRequest,
  Item,
  ItemOf,
  Project,
  RawEventEnvelope,
  RespondRequest,
  Session,
} from "@codeden/contracts";
import { badRequest, errorMessage } from "../errors";
import { type FactoryContext, raiseInbox } from "./context";
import { isFactorySession } from "./sessions";

/**
 * Dark factory (§10.1): "set the vision and the limits, then step away". Nobody is watching, so
 * the factory's agents and the project's PM never wait on the user. A question they would have
 * asked is answered at once with {@link UNATTENDED_ANSWER}: decide from the vision, record the
 * decision with `factory_record_decision`, and carry on. The decision reaches the inbox and the
 * daily digest, where the user can review or override it later.
 */

/** Prefix of the inbox items `factory_record_decision` raises (the digest lists them). */
export const DECISION_INBOX_PREFIX = "inbox:factory-decision:";

/** The answer an unattended factory agent gets instead of waiting for the user. */
export const UNATTENDED_ANSWER = [
  "Not asked: this project runs as a dark factory, so nobody is watching to answer. Decide yourself:",
  "- Follow the project vision. It wins over the current code: when the code doesn't match the vision (a different stack or architecture, say), the work that brings it in line comes first, as its own item, and work that would be thrown away by it waits.",
  "- Stay inside the vision's scope and the factory's limits, and prefer the smaller, reversible option.",
  "Then call `factory_record_decision` with the question, what you decided and why, so the user can review and override it later, and carry on.",
  "Set `needsHuman: true` only for a protected area, a vision that is missing or contradicts itself, or something irreversible outside the code (deploys, releases, data, money). That flags it for the user without waiting: skip only the work that depends on it.",
  "If the user is talking to you directly in this conversation, ask them in your reply instead.",
].join("\n");

/**
 * The denial an unattended factory session gets instead of waiting for an approval. Nothing is
 * ever approved on the user's behalf: the agent finds a way that needs no approval, or flags it.
 */
export const UNATTENDED_APPROVAL = [
  "Not approved: this project runs as a dark factory, so nobody is watching to approve it. Don't wait for it or try the same thing again.",
  "- Find a way that stays inside your worktree and the factory's limits. To publish your work, commit it and call `create_pull_request`: it pushes your own branch (with a lease after a rebase).",
  "- If the work can't be done without this, call `factory_record_decision` with `needsHuman: true`, saying what you needed and why, and carry on with whatever doesn't depend on it.",
].join("\n");

/**
 * True when nobody is expected to answer this session's questions: its project is a dark factory
 * and the session is the PM or one of the factory's own agent sessions. Sessions the user
 * started themselves still ask as usual.
 */
export function isUnattended(project: Project | undefined, session: Session): boolean {
  if (project?.autonomyMode !== "dark_factory") return false;
  return session.role === "pm" || isFactorySession(session);
}

/** The session behind `sessionId` when nobody is expected to answer its questions. */
export function unattendedSession(
  ctx: Pick<FactoryContext, "repo" | "projects">,
  sessionId: string,
): Session | undefined {
  const session = ctx.repo.find(sessionId)?.session;
  if (!session?.projectId) return undefined;
  let project: Project;
  try {
    project = ctx.projects.get(session.projectId);
  } catch {
    return undefined;
  }
  return isUnattended(project, session) ? session : undefined;
}

/** Answers for a provider's own question request, one free-text answer per question. */
export function unattendedAnswers(item: ItemOf<"user_question">): Record<string, string[]> {
  return Object.fromEntries(item.questions.map((q) => [q.id, [UNATTENDED_ANSWER]]));
}

/**
 * A question the provider asked through its own tool (not `ask_user`) in an unattended
 * session: answer it straight away with {@link UNATTENDED_ANSWER}, so the turn never waits. An
 * MCP server's form is withdrawn instead: its answers would go to the server as data.
 */
export async function answerProviderQuestion(
  ctx: Pick<FactoryContext, "repo" | "projects" | "log">,
  respond: (sessionId: string, req: RespondRequest) => Promise<void>,
  e: RawEventEnvelope,
): Promise<boolean> {
  if (e.type !== "agent.item.started" || !e.sessionId) return false;
  const item = (e.payload as { item?: Item }).item;
  if (item?.kind !== "user_question" || item.deferred || item.status !== "in_progress") {
    return false;
  }
  if (!unattendedSession(ctx, e.sessionId)) return false;
  try {
    await respond(e.sessionId, {
      requestId: item.requestId,
      response: item.mcpServer
        ? { kind: "cancel" }
        : { kind: "answer", answers: unattendedAnswers(item) },
    });
    return true;
  } catch (error) {
    ctx.log?.(`factory: answer question in ${e.sessionId}: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * `factory_record_decision`: put a factory decision in front of the user (the inbox and the
 * daily digest). Also used for the PM's size allowances.
 */
export function recordDecision(
  ctx: FactoryContext,
  by: { projectId: string | null; sessionId: string | null },
  req: Omit<FactoryDecisionRequest, "needsHuman"> & { needsHuman?: boolean },
): { inboxItemId: string; message: string } {
  if (!by.projectId) {
    throw badRequest("Only a project's sessions record factory decisions", "no_project");
  }
  const id = `${DECISION_INBOX_PREFIX}${randomUUID()}`;
  raiseInbox(ctx, {
    id,
    kind: "message",
    // Only a flagged decision needs the user; the rest are for the inbox and the digest.
    notify: req.needsHuman ? "needs_you" : "factory",
    priority: req.needsHuman ? "high" : "low",
    projectId: by.projectId,
    sessionId: by.sessionId,
    title: `${req.needsHuman ? "Factory needs you" : "Factory decided"}: ${oneLine(req.question, 120)}`,
    body: [
      `**Question:** ${req.question}`,
      "",
      `**Decision:** ${req.decision}`,
      "",
      `**Why:** ${req.reasoning}`,
      "",
      req.needsHuman
        ? "The factory carried on with everything that doesn't depend on this. Reply in the session, or change the vision, to settle it."
        : "Nothing waited on you. To change it, tell the project manager or edit the vision.",
    ].join("\n"),
  });
  return {
    inboxItemId: id,
    message: req.needsHuman
      ? "Recorded and flagged for the user. Don't wait: carry on with the work that doesn't depend on it."
      : "Recorded. Carry on.",
  };
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
