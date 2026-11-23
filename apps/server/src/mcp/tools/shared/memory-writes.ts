import { type MemoryWriteMode, type Role, redactAndCount, type Session } from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
import { ToolError } from "../../define";
import { issuesNamed } from "../pm/issue-trust";

interface Caller {
  role: Role;
  sessionId: string | null;
}

/**
 * What a PM or an agent may write to a shared memory store (project notes, group memory). Agents
 * only add sections: they may work on input nobody vetted, and their notes reach other sessions,
 * so rewriting what others recorded stays with the PM and the user. A read-only session writes
 * nothing, and neither does one working on an issue whose author isn't trusted (the rule that
 * keeps such issues from starting work, `issue-trust.ts`): that issue's text could otherwise
 * plant instructions in what every project's sessions read. Secret-looking values are masked
 * before anything is stored: the event log keeps every write.
 */
export async function memoryWrite(
  services: AppServices,
  caller: Caller,
  content: string,
  mode: MemoryWriteMode,
): Promise<string> {
  if (caller.role === "agent") {
    if (mode === "replace") {
      throw new ToolError("Agents can only append; ask your project manager to rewrite it.");
    }
    const session = caller.sessionId ? services.sessionRepo.find(caller.sessionId)?.session : null;
    if (session?.autonomy === "read_only") {
      throw new ToolError("This session is read-only: report the fact instead of writing it.");
    }
    const untrusted = session ? await untrustedIssue(services, session) : null;
    if (untrusted !== null) {
      throw new ToolError(
        `Not written: this session works on issue #${untrusted}, whose author isn't trusted, so it can't write to memory other sessions read. Put what you learned in your final message instead.`,
      );
    }
  }
  return redactAndCount(content).text;
}

/** The first issue the session works on whose author isn't trusted; null when there is none. */
async function untrustedIssue(services: AppServices, session: Session): Promise<number | null> {
  if (!session.projectId) return null;
  const project = services.projects.get(session.projectId);
  if (project.kind !== "github") return null;
  const numbers = issuesNamed({ issueNumber: session.issue?.number, workKey: session.workKey });
  for (const number of numbers) {
    const trust = await services.automations.triage.issueAuthorTrust(project, number);
    if (!trust.trusted) return number;
  }
  return null;
}

/**
 * The line that opens every entry a PM or agent writes to group memory, so its readers in other
 * projects can see where it came from.
 */
export function memorySource(
  services: AppServices,
  projectId: string,
  caller: Caller,
  now = new Date(),
): string {
  const project = services.projects.get(projectId).name;
  const day = now.toISOString().slice(0, 10);
  return `_Source: project "${project}", ${caller.role} session ${caller.sessionId ?? "none"}, ${day}_`;
}
