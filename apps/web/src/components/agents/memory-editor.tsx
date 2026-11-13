import { ConfigFilesView } from "./config-files-view";
import { useSkillSwitches } from "./skill-switches";

/** Memory files of every provider (CLAUDE.md, rules, auto memory, AGENTS.md), edited in place. */
export function MemoryEditor({ projectId }: { projectId: string | null }) {
  return (
    <ConfigFilesView
      projectId={projectId}
      kinds={["memory", "rule", "auto_memory"]}
      emptyText="No memory files found."
    />
  );
}

/**
 * Each provider's user and project skill folders (`<name>/SKILL.md`), each with a switch that
 * writes its provider's own setting.
 */
export function SkillsView({ projectId }: { projectId: string | null }) {
  const switches = useSkillSwitches(projectId);
  return (
    <>
      <ConfigFilesView
        projectId={projectId}
        kinds={["skill"]}
        create="skill"
        placeholder="Describe when the skill applies and the steps to follow…"
        emptyText="No skills yet. Create one to teach agents a repeatable workflow."
        rowAddon={switches.addon}
        onFilesChanged={() => void switches.refetch()}
      />
      {switches.dialog}
    </>
  );
}

/** Claude subagents (`.claude/agents`) and Codex agents (`.codex/agents`). */
export function SubagentsView({ projectId }: { projectId: string | null }) {
  return (
    <ConfigFilesView
      projectId={projectId}
      kinds={["subagent"]}
      create="subagent"
      placeholder="Describe the subagent's role, tools and what it returns…"
      emptyText="No subagents yet."
    />
  );
}
