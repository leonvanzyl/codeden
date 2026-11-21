import { type MemoryWriteMode, type Role, redactAndCount } from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
import { ToolError } from "../../define";

/**
 * What a PM or an agent may write to a shared memory store (project notes, group memory). Agents
 * only add sections: they may work on input nobody vetted, and their notes reach other sessions,
 * so rewriting what others recorded stays with the PM and the user. A read-only session writes
 * nothing. Secret-looking values are masked before anything is stored: the event log keeps every
 * write.
 */
export function memoryWrite(
  services: AppServices,
  caller: { role: Role; sessionId: string | null },
  content: string,
  mode: MemoryWriteMode,
): string {
  if (caller.role === "agent") {
    if (mode === "replace") {
      throw new ToolError("Agents can only append; ask your project manager to rewrite it.");
    }
    const session = caller.sessionId ? services.sessionRepo.find(caller.sessionId) : null;
    if (session?.session.autonomy === "read_only") {
      throw new ToolError("This session is read-only: report the fact instead of writing it.");
    }
  }
  return redactAndCount(content).text;
}
