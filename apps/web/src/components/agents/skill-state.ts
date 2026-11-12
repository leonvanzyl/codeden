import type { AgentConfigScope, AgentSkill } from "@codeden/contracts";

/** A short label for a skill that isn't plainly on: "off", or a partial state's native name. */
export function skillStateLabel(s: Pick<AgentSkill, "enabled" | "visibility">): string | null {
  if (!s.enabled) return "off";
  if (s.visibility === "name-only") return "name-only";
  if (s.visibility === "user-invocable-only") return "user-only";
  return null;
}

/** What a skill's state means, for tooltips. */
export function skillStateTitle(s: Pick<AgentSkill, "enabled" | "visibility" | "setIn">): string {
  const what = !s.enabled
    ? "Off: the agent doesn't see it and / doesn't offer it"
    : s.visibility === "name-only"
      ? "On, name only: the agent sees its name without the description"
      : s.visibility === "user-invocable-only"
        ? "On for you only: the agent doesn't see it, but you can type /name"
        : "On";
  return s.setIn ? `${what}. Set in ${s.setIn}` : what;
}

/** Who a switch written at this scope applies to. */
export const SWITCH_SCOPE_NOTE: Record<AgentConfigScope, string> = {
  user: "Written to your user settings, so it applies in every project.",
  project:
    "Written to the project's shared settings, so it applies to everyone using the repository.",
  local: "Written to your local settings for this project, so it applies only to you, here.",
};
