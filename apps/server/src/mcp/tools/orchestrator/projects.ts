import { AutonomyLevel, type Project, ProviderId } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";
import { projectFor } from "../shared/helpers";

function compactProject(p: Project) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    path: p.path,
    github: p.kind === "github" ? `${p.github.owner}/${p.github.repo}` : null,
    defaultBranch: p.defaultBranch,
    defaultProvider: p.defaultProvider,
    autonomy: p.autonomy,
    autonomyMode: p.autonomyMode,
    agentCiEnv: p.agentCiEnv,
  };
}

/** `list_projects` (§8.3): every active project. */
export const listProjects = defineTool({
  name: "list_projects",
  description:
    "List every CodeDen project with its id, name, kind (github or local), path and defaults. Use the ids with ask_pm, message_pm and update_project.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({}),
  handler: async (_input, { services }) => ({
    projects: services.projects.list().map(compactProject),
  }),
});

/** `create_project` (§8.3): add a local folder or clone a GitHub repo. */
export const createProject = defineTool({
  name: "create_project",
  description:
    "Add a project: either an existing local folder (`path`) or a git URL / owner/repo to clone (`cloneUrl`). Only do this when the user asked for it.",
  roles: ["orchestrator"],
  scope: "global",
  input: z
    .object({
      path: z.string().min(1).optional().describe("Absolute path of an existing folder"),
      cloneUrl: z.string().min(1).optional().describe("https URL, git@ URL or owner/repo"),
      name: z.string().trim().min(1).max(100).optional(),
      defaultProvider: ProviderId.optional(),
      autonomy: AutonomyLevel.optional(),
    })
    .refine((v) => Boolean(v.path) !== Boolean(v.cloneUrl), {
      message: "Give exactly one of path or cloneUrl",
    }),
  handler: async (input, { services }) => {
    const source = input.path
      ? { type: "local" as const, path: input.path }
      : { type: "clone" as const, url: input.cloneUrl as string };
    const created = await services.projects.create({
      source,
      name: input.name,
      defaultProvider: input.defaultProvider,
      autonomy: input.autonomy,
    });
    return { project: compactProject(created.project), detected: created.detected };
  },
});

/** `update_project` (§8.3): rename or change a project's defaults. */
export const updateProject = defineTool({
  name: "update_project",
  description:
    "Change a project's name, default provider, default autonomy level, timezone, default branch, or whether its agent sessions run with CI=true. Pass null to clear an override.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    defaultProvider: ProviderId.nullable().optional(),
    autonomy: AutonomyLevel.nullable().optional(),
    timezone: z.string().nullable().optional(),
    defaultBranch: z.string().nullable().optional(),
    agentCiEnv: z
      .boolean()
      .optional()
      .describe(
        "false: agent sessions opened from now on run without CI=true (only when the user asks, e.g. their Playwright or Yarn setup misbehaves under CI)",
      ),
  }),
  handler: async ({ projectId, ...patch }, { services }) => {
    projectFor(services, projectId);
    if (Object.values(patch).every((v) => v === undefined))
      throw new ToolError("Nothing to change");
    return { project: compactProject(services.projects.update(projectId, patch)) };
  },
});
