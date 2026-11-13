import type { Session, StartedBy } from "@codeden/contracts";

/** Who starts factory sessions; `id: "factory"` marks them for limits and the kill switch. */
export const FACTORY_STARTER: StartedBy = { kind: "pm", id: "factory" };

/** A session the factory loop started (builder, reviewer, scout, lens or revert). */
export function isFactorySession(s: Pick<Session, "startedBy">): boolean {
  return s.startedBy.kind === FACTORY_STARTER.kind && s.startedBy.id === FACTORY_STARTER.id;
}
