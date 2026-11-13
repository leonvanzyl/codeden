import type { Project } from "@codeden/contracts";
import type { AuthorTrust } from "../../../services/automations/triage";
import type { AppServices } from "../../../services/container";
import { ToolError } from "../../define";

/**
 * Untrusted issues and the PM's own tools (#137, §10). In a turn that a triage run, a GitHub
 * or factory notice, a wake-up or another agent started, the PM reads issues anyone can write.
 * So in those turns its tools refuse to start work on an issue whose author isn't trusted:
 * only the user's own words (a message to the PM, or one the orchestrator passes on from a
 * turn the user started) can do that. Prompt wording alone is not the barrier.
 */

/** Who calls a PM tool: its token's session, through MCP or a UI handler. */
interface Caller {
  caller: "mcp" | "ui";
  sessionId: string | null;
}

/** Whether the caller's current turn carries the user's own request. */
export function userAskedThisTurn(services: AppServices, caller: Caller): boolean {
  return services.orchestration.loops.humanLed(caller);
}

/** The issues a `start_session` call names: `issueNumber` and an `issue:<n>` work key. */
export function issuesNamed(input: { issueNumber?: number; workKey?: string }): number[] {
  const fromKey = /^issue:#?(\d+)\b/.exec(input.workKey ?? "")?.[1];
  const numbers = [input.issueNumber, fromKey ? Number(fromKey) : undefined];
  return [...new Set(numbers.filter((n): n is number => n !== undefined && n > 0))];
}

/**
 * Refuse to start a session on issues whose author isn't trusted (the rule triage uses), unless
 * the user asked for it in this turn. Projects without GitHub issues have no outside authors.
 */
export async function assertMayStartOnIssues(
  services: AppServices,
  caller: Caller,
  project: Project,
  numbers: number[],
): Promise<void> {
  if (project.kind !== "github" || numbers.length === 0) return;
  if (userAskedThisTurn(services, caller)) return;
  for (const number of numbers) {
    const trust = await services.automations.triage.issueAuthorTrust(project, number);
    if (!trust.trusted) throw new ToolError(startRefusal(number, trust));
  }
}

/** Refuse `factory_admit_issue` unless the user asked for it in this turn. */
export function assertMayAdmit(services: AppServices, caller: Caller): void {
  if (userAskedThisTurn(services, caller)) return;
  const raise =
    caller.sessionId && services.factory.isUnattended(caller.sessionId)
      ? "record it with factory_record_decision (needsHuman: true)"
      : "ask them with ask_user";
  throw new ToolError(
    `Not let in: only the user can let in an issue whose author isn't trusted, and this turn wasn't started by the user's own message. It stays in the factory's ignored list, where the user can let it in. If it looks worth taking on, ${raise}. Don't call factory_admit_issue for it again in this turn.`,
  );
}

function startRefusal(number: number, { author, checked }: AuthorTrust): string {
  const who = author ? `@${author}` : "an unknown author";
  const why = checked
    ? `${who}, who isn't a trusted author and has no write access to the repository`
    : `${who}, who isn't a trusted author (CodeDen couldn't check their write access on GitHub)`;
  return `Not started: issue #${number} was opened by ${why}, and this turn wasn't started by the user's own message, so only the user can decide to start work on it. Put it in their inbox instead: report_triage with decision "ready" and a short summary asks them "Should I take this on?". Don't call start_session for it again in this turn.`;
}
