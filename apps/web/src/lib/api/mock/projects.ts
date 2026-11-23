import { type BackendStatus, isActiveSession, type Project } from "@codeden/contracts";
import type { CodeDenClient } from "../client";
import { ApiRequestError } from "../http";
import { defaultFactoryLimits } from "./fixtures/ops";
import { uid } from "./live";
import type { MockWorld } from "./world";

type MockProjectApi = Pick<
  CodeDenClient,
  | "createProject"
  | "updateProject"
  | "executionBackends"
  | "reorderProjects"
  | "refreshProject"
  | "disconnectGithub"
  | "archiveProject"
>;

const NOT_GITHUB =
  "Docker sandboxes need a GitHub project: each container clones the repository from GitHub";

/** The mock machine has Docker; a local project still can't use it. */
function mockBackends(project?: Project): BackendStatus[] {
  const docker: BackendStatus = {
    backend: "docker",
    available: true,
    code: "ok",
    version: "29.6.1",
    reason: null,
    fix: null,
  };
  return [
    { backend: "local", available: true, code: "ok", version: null, reason: null, fix: null },
    project && project.kind !== "github"
      ? { ...docker, available: false, code: "unsupported_project", reason: NOT_GITHUB }
      : docker,
  ];
}

const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

/** Projects in the mock: add, update (and pin), reorder. Mirrors the server's validation. */
export function mockProjectApi(world: MockWorld): MockProjectApi {
  const find = (id: string) => {
    const project = world.snapshot.projects.find((p) => p.id === id);
    if (!project) throw new ApiRequestError(404, "project_not_found", `No project ${id}`);
    return project;
  };

  return {
    async createProject(input) {
      const { source } = input;
      const path =
        source.type === "local"
          ? source.path
          : `C:\\Users\\leon\\Code\\${source.url
              .split("/")
              .at(-1)
              ?.replace(/\.git$/, "")}`;
      const name = input.name ?? path.split("\\").at(-1) ?? "project";
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 40) || "project";
      const now = new Date().toISOString();
      const last = Math.max(-1, ...world.snapshot.projects.map((p) => p.sortOrder));
      const project: Project = {
        id: uid("p"),
        kind: "local",
        name,
        slug,
        path,
        isGitRepo: true,
        defaultBranch: "main",
        defaultProvider: null,
        defaultModel: null,
        defaultEffort: null,
        autonomy: null,
        autonomyMode: "assisted",
        visionPath: ".codeden/VISION.md",
        factoryLimits: defaultFactoryLimits,
        killSwitch: false,
        timezone: null,
        agentCiEnv: true,
        execution: { backend: "local" },
        pinned: false,
        sortOrder: last + 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      world.emitDomain({ type: "project.created", sessionId: null, payload: { project } });
      return later(
        {
          project,
          detected: {
            isGitRepo: true,
            gitRoot: path,
            remoteUrl: null,
            github: null,
            defaultBranch: "main",
            currentBranch: "main",
            packageManager: "pnpm" as const,
            suggestedSetupCommands: ["pnpm install"],
          },
        },
        400,
      );
    },

    async executionBackends({ projectId } = {}) {
      return later({ backends: mockBackends(projectId ? find(projectId) : undefined) }, 120);
    },

    async updateProject(id, patch) {
      if (patch.execution?.backend === "docker" && find(id).kind !== "github") {
        throw new ApiRequestError(400, "backend_unavailable", NOT_GITHUB);
      }
      const project = {
        ...find(id),
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        updatedAt: new Date().toISOString(),
      } as Project;
      world.emitDomain({ type: "project.updated", sessionId: null, payload: { project } });
      return later(project, 80);
    },

    async reorderProjects(projectIds) {
      const active = world.snapshot.projects.map((p) => p.id);
      const unique = new Set(projectIds);
      if (
        unique.size !== projectIds.length ||
        unique.size !== active.length ||
        active.some((id) => !unique.has(id))
      ) {
        throw new ApiRequestError(
          400,
          "invalid_order",
          "The order must list every active project exactly once",
        );
      }
      world.emitDomain({ type: "projects.reordered", sessionId: null, payload: { projectIds } });
      return later(world.snapshot.projects, 80);
    },

    // The mock has no folders to look at: every check finds the project as it is.
    async refreshProject(id) {
      const project = find(id);
      const message =
        project.kind === "github"
          ? project.remoteWarning
            ? `This folder has no GitHub remote on origin any more; GitHub features still use ${project.github.owner}/${project.github.repo}`
            : `Connected to ${project.github.owner}/${project.github.repo}`
          : "Still no GitHub remote on origin";
      const outcome = project.remoteWarning ? "github_remote_missing" : "unchanged";
      return later({ project, outcome, changed: false, message, detected: null }, 300);
    },

    async disconnectGithub(id) {
      const current = find(id);
      if (current.kind !== "github") {
        throw new ApiRequestError(409, "not_a_github_project", `${current.name} is not on GitHub`);
      }
      const { github: _github, remoteWarning: _warning, ...rest } = current;
      const project: Project = { ...rest, kind: "local", updatedAt: new Date().toISOString() };
      world.emitDomain({ type: "project.updated", sessionId: null, payload: { project } });
      return later({ project }, 80);
    },

    async archiveProject(id) {
      const { id: projectId } = find(id);
      // As the server does: refused while a session of the project is working or about to.
      if (world.snapshot.sessions.some((s) => s.projectId === projectId && isActiveSession(s))) {
        throw new ApiRequestError(
          409,
          "project_has_active_sessions",
          "Sessions of this project are still working or waiting to start. Stop them first.",
        );
      }
      world.emitDomain({ type: "project.archived", sessionId: null, payload: { projectId } });
      return later(undefined, 80);
    },
  };
}
