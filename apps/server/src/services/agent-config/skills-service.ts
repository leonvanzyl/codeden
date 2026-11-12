import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentConfigLocator,
  type AgentConfigScope,
  type AgentSkill,
  agentConfigFeatures,
  type SkillSwitchDiff,
  type SkillSwitchRequest,
  type SkillSwitchResponse,
} from "@codeden/contracts";
import { badRequest, notFound } from "../errors";
import { listSkills, type ProjectRef } from "./catalog";
import type { DiscoveredSkill } from "./discovery";
import { atomicWrite, unifiedDiff } from "./files";
import { claudeHookFile, claudeSessionHookFiles, type HookFile } from "./hooks";
import { guard } from "./hooks-service";
import {
  decidingOverride,
  highestFirst,
  type OverrideFile,
  planOverride,
  readOverrides,
  renderOverride,
} from "./skill-overrides";
import { readRules, renderRuleSwitch, ruleState } from "./skill-rules";

export interface AgentConfigSkillsDeps {
  home: string;
  project: (id: string) => ProjectRef;
  /** Copy a file to the agent-config backups folder; returns the copy's path. */
  backup: (file: string) => string;
  /** Validate a locator and resolve it to an absolute path (`AgentConfigFiles.resolve`). */
  resolve: (locator: AgentConfigLocator) => { absolutePath: string };
}

/** The Claude Code settings files that apply where skills are listed, lowest precedence first. */
type ClaudeContext = HookFile[];

/** A planned switch: the file it writes, its scope, and the text before and after. */
interface Plan {
  file: Pick<HookFile, "root" | "file">;
  scope: AgentConfigScope;
  render: () => { before: string; after: string; existed: boolean; changed: boolean };
}

const fold = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());

/**
 * Skill switches (§12.4): whether each skill is on, read from its provider's native setting,
 * and switching one on or off by writing that setting. Every write is previewed by `diff`,
 * backed up first and atomic. See `agent-config-skills.ts` in contracts for the rules.
 */
export class AgentConfigSkills {
  constructor(private readonly deps: AgentConfigSkillsDeps) {}

  /** The user's skills, plus the project's, with their state for the project's checkout. */
  list(projectId?: string): AgentSkill[] {
    const project = projectId ? this.deps.project(projectId) : null;
    return this.withState(listSkills(this.deps.home, project), this.pageContext(project));
  }

  /** The state of the skills a session in `cwd` finds (What's loaded, the `/` menu). */
  forSession(
    skills: DiscoveredSkill[],
    cwd: string,
    gitRoot: string | null,
    projectId: string | null,
  ): AgentSkill[] {
    const context = claudeSessionHookFiles(this.deps.home, cwd, gitRoot, projectId);
    return this.withState(skills, context);
  }

  diff(req: SkillSwitchRequest): SkillSwitchDiff {
    const plan = this.plan(req);
    const { before, after, existed } = plan.render();
    return { ...unifiedDiff(plan.file.file, existed, before, after), scope: plan.scope };
  }

  apply(req: SkillSwitchRequest): SkillSwitchResponse {
    const plan = this.plan(req);
    const { after, existed, changed } = plan.render();
    if (!changed) return { file: null, backupPath: null, skills: this.list(req.listProjectId) };
    const backupPath = existed ? this.deps.backup(plan.file.file) : null;
    // Check again once the folder exists, right before writing, so a link created since the
    // plan can't redirect the write.
    mkdirSync(dirname(plan.file.file), { recursive: true });
    guard(plan.file);
    atomicWrite(plan.file.file, after);
    return { file: plan.file.file, backupPath, skills: this.list(req.listProjectId) };
  }

  // ------------------------------------------------------------------- helpers

  private withState(skills: DiscoveredSkill[], context: ClaudeContext): AgentSkill[] {
    // Listing is tolerant: a file that can't be read safely sets nothing (`readOverrides`).
    const claude = highestFirst(context.map((f) => readOverrides(f)));
    const codexRules = this.codexRules();
    return skills.map((skill) => {
      if (skill.provider === "codex") {
        const state = ruleState(codexRules, { name: skill.name, path: skill.file.absolutePath });
        return { ...skill, enabled: state.enabled, setIn: state.set ? this.codexConfig() : null };
      }
      const deciding = decidingOverride(claude, skill.name);
      const value = deciding?.value;
      return {
        ...skill,
        enabled: value !== "off",
        ...(value === "name-only" || value === "user-invocable-only" ? { visibility: value } : {}),
        setIn: deciding?.file.source.file ?? null,
      };
    });
  }

  /** Claude's settings files for the Agents page: the user's, plus the project's. */
  private pageContext(project: ProjectRef | null): ClaudeContext {
    const home = this.deps.home;
    const user = claudeHookFile("user", home, null);
    if (!project) return [user];
    return [user, claudeHookFile("project", home, project), claudeHookFile("local", home, project)];
  }

  private codexConfig(): string {
    return join(this.deps.home, ".codex", "config.toml");
  }

  /** Codex's rules for listing; none when config.toml leads outside home or doesn't parse. */
  private codexRules(): unknown[] {
    try {
      guard({ root: this.deps.home, file: this.codexConfig() });
    } catch {
      return [];
    }
    return readRules(this.codexConfig());
  }

  /**
   * What a switch will do, with every input checked first: the skill must be one listed for
   * `listProjectId` (404 `skill_not_found`); every settings file that applies must be readable
   * and inside its folder (422 `config_unparsable`, 403 `path_outside_root`), so the target is
   * never chosen around a file that can't be read; and the file written must stay inside its
   * folder.
   */
  private plan(req: SkillSwitchRequest): Plan {
    if (!agentConfigFeatures[req.provider].skillSwitches) {
      throw badRequest(`CodeDen does not switch ${req.provider} skills`, "skills_unsupported");
    }
    const project = req.listProjectId ? this.deps.project(req.listProjectId) : null;
    const { provider, enabled, listProjectId: _, ...locator } = req;
    const absolutePath = fold(this.deps.resolve(locator).absolutePath);
    const skill = listSkills(this.deps.home, project).find(
      (s) => s.provider === provider && fold(s.file.absolutePath) === absolutePath,
    );
    if (!skill) {
      throw notFound(`No ${provider} skill at ${req.path}; reload the list`, "skill_not_found");
    }
    if (provider === "codex") {
      const file = { root: this.deps.home, file: this.codexConfig() };
      guard(file);
      const target = { name: skill.name, path: skill.file.absolutePath };
      const byPath = skill.scope === "user";
      return {
        file,
        scope: "user",
        render: () => renderRuleSwitch(file.file, target, byPath, enabled),
      };
    }
    const files: OverrideFile[] = this.pageContext(project).map((f) => readOverrides(f, true));
    const userFile = claudeHookFile("user", this.deps.home, null);
    const { target, value } = planOverride(files, userFile, skill.name, enabled);
    guard(target);
    return {
      file: target,
      scope: target.scope,
      render: () => renderOverride(target.file, skill.name, value),
    };
  }
}
