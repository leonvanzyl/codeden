import { AutonomyLevel, type Project, ProviderId } from "@codeden/contracts";
import { z } from "zod";
import { defineTool, ToolError } from "../../define";
import { projectFor } from "../shared/helpers";
import { assertProviderLoaded, describeProviderParam } from "../shared/provider-choices";

/** The loaded providers and whether each is ready, as the PM's `start_session` lists them. */
const describeDefaultProvider = describeProviderParam(
  "defaultProvider",
  "The provider this project's sessions use unless one is named.",
  "An id that isn't loaded is refused while the runner is connected. A session uses it only while it is loaded (one the PM starts without naming a provider, only while it is ready), and otherwise falls back to the Settings default. Pick one that is ready.",
);

function compactProject(p: Project) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    path: p.path,
    // False: no worktrees, its sessions run in the project folder (§9).
    isGitRepo: p.isGitRepo,
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
  describeInput: describeDefaultProvider,
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
    await assertProviderLoaded(services, input.defaultProvider);
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
    "Change a project's name, default provider, default autonomy level, timezone, default branch, or whether its agent sessions run with CI=true. Pass null to clear an override. The autonomy level (read_only, supervised, auto, full: which actions an agent asks about) is what the project's new sessions start with: sessions that exist keep theirs, which the user changes in each session's Permissions picker. It is not the project's autonomy mode (who finds work and who merges), which this tool doesn't change.",
  roles: ["orchestrator"],
  scope: "global",
  describeInput: describeDefaultProvider,
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
    await assertProviderLoaded(services, patch.defaultProvider);
    const project = compactProject(services.projects.update(projectId, patch));
    if (patch.autonomy === undefined) return { project };
    return {
      project,
      note: "New sessions in this project start with this level. Sessions that already exist keep the level they have; the user changes it in each session's Permissions picker.",
    };
  },
});
