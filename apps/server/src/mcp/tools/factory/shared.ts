import { isFactoryMode } from "@codeden/contracts";
import type { AppServices } from "../../../services/container";
import { ServiceError } from "../../../services/errors";
import { type ToolAvailabilityContext, ToolError } from "../../define";

/** Whether the caller works in a project running the software or dark factory. */
export function inFactoryProject(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  if (!caller) return true;
  if (!caller.projectId) return false;
  try {
    return isFactoryMode(services.projects.get(caller.projectId).autonomyMode);
  } catch {
    return false;
  }
}

/** Listed only to sessions `test` accepts (every session when listing the whole registry). */
export function forSession(test: (services: AppServices, sessionId: string) => boolean) {
  return (services: AppServices, caller?: ToolAvailabilityContext): boolean => {
    if (!caller) return true;
    return caller.sessionId !== null && test(services, caller.sessionId);
  };
}

/** Service errors become tool errors the agent can read. */
export async function asTool<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) throw new ToolError(error.message);
    throw error;
  }
}
