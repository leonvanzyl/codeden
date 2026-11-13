import type { AgentConfigDiff, AgentSkill, SkillVisibility } from "@codeden/contracts";
import type { AgentConfigApi } from "../feature-apis";
import { configFiles } from "./fixtures/config";

/**
 * In-memory skill switches for the mock client (`VITE_CODEDEN_MOCK=1`): one value per skill,
 * written to the provider's user-level file the way the server does it (Claude
 * `skillOverrides`, Codex `[[skills.config]]`).
 */

const HOME = "C:\\Users\\you";
const CLAUDE_SETTINGS = `${HOME}\\.claude\\settings.json`;
const CODEX_CONFIG = `${HOME}\\.codex\\config.toml`;

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

type State = { value: "off" | SkillVisibility };

export function mockSkillsApi(
  diff: (path: string, before: string, after: string) => AgentConfigDiff,
): Pick<AgentConfigApi, "listSkills" | "diffSkillSwitch" | "switchSkill"> & {
  /** The skills with their state, for What's loaded. */
  skills: () => AgentSkill[];
} {
  // One skill starts with a partial state so the chip shows.
  const states = new Map<string, State>([["frontend-design", { value: "name-only" }]]);
  const skills = (): AgentSkill[] =>
    configFiles
      .filter((f) => f.kind === "skill")
      .map((f) => {
        const state = states.get(f.name);
        const visibility = state && state.value !== "off" ? state.value : undefined;
        return {
          provider: f.provider,
          scope: f.scope,
          name: f.name,
          description: f.description,
          file: f,
          enabled: state?.value !== "off",
          ...(visibility ? { visibility } : {}),
          setIn: state ? (f.provider === "codex" ? CODEX_CONFIG : CLAUDE_SETTINGS) : null,
        };
      });
  const render = (provider: string, entries: [string, string][]) =>
    provider === "codex"
      ? entries
          .map(([name, v]) => `[[skills.config]]\nname = "${name}"\nenabled = ${v !== "off"}\n`)
          .join("\n")
      : `${JSON.stringify({ skillOverrides: Object.fromEntries(entries) }, null, 2)}\n`;
  const snapshot = (provider: string) =>
    [...states.entries()]
      .filter(([name]) => skills().some((s) => s.name === name && s.provider === provider))
      .map(([name, s]): [string, string] => [name, s.value]);
  const find = (path: string) => skills().find((s) => s.file.path === path);

  return {
    skills,
    listSkills: () => delay({ skills: skills() }),
    diffSkillSwitch: (req) => {
      const skill = find(req.path);
      const before = render(req.provider, snapshot(req.provider));
      const after = render(
        req.provider,
        snapshot(req.provider)
          .filter(([name]) => name !== skill?.name)
          .concat(req.enabled || !skill ? [] : [[skill.name, "off"]]),
      );
      const file = req.provider === "codex" ? CODEX_CONFIG : CLAUDE_SETTINGS;
      return delay({ ...diff(file, before, after), absolutePath: file, scope: "user" as const });
    },
    switchSkill: (req) => {
      const skill = find(req.path);
      if (skill) {
        if (req.enabled) states.delete(skill.name);
        else states.set(skill.name, { value: "off" });
      }
      const file = req.provider === "codex" ? CODEX_CONFIG : CLAUDE_SETTINGS;
      return delay(
        { file, backupPath: "~/.codeden/backups/agent-config/settings.json", skills: skills() },
        200,
      );
    },
  };
}
