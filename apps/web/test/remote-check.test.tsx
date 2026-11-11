import type { EventEnvelope, Project, RefreshProjectResponse, Snapshot } from "@codeden/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { ProjectGithub } from "@/components/github/project-github";
import { createMockClient } from "@/lib/api/mock";
import { projects as fixtureProjects } from "@/lib/api/mock/fixtures/world";
import { snapshotKey, useProject } from "@/lib/queries";
import { applyDomainEvent } from "@/lib/snapshot-reducer";
import { renderWithClient } from "./utils";

const local = fixtureProjects.find((p) => p.id === "p-notes") as Project;
const github = {
  owner: "octo",
  repo: "notes-cli",
  remoteUrl: "https://github.com/octo/notes-cli.git",
  defaultBranch: "main",
};
const connected: Project = { ...local, kind: "github", github };

/** The project as the live snapshot has it, like the project page renders it. */
function LiveGithubTab({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  return project ? <ProjectGithub project={project} /> : null;
}
function LiveAutonomy({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  return project ? (
    <AutonomyDialog project={project} open onOpenChange={() => {}} initialMode="software_factory" />
  ) : null;
}

/** What the realtime socket does with a server event: apply it to the snapshot. */
function serverEvent(queryClient: QueryClient, project: Project) {
  queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
    s
      ? applyDomainEvent(s, {
          type: "project.updated",
          sessionId: null,
          payload: { project },
          seq: s.seq + 1,
          ts: new Date().toISOString(),
        } as EventEnvelope)
      : s,
  );
}

const response = (patch: Partial<RefreshProjectResponse>): RefreshProjectResponse => ({
  project: local,
  outcome: "unchanged",
  changed: false,
  message: "Still no GitHub remote on origin",
  detected: null,
  ...patch,
});

describe("Check again (re-detect the GitHub remote)", () => {
  it("says honestly when there is still no GitHub remote", async () => {
    const client = createMockClient();
    const refresh = vi.fn(async () => response({}));
    client.refreshProject = refresh;
    renderWithClient(<LiveGithubTab projectId={local.id} />, client);

    expect(await screen.findByText("Local-only project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Still no GitHub remote on origin",
    );
    expect(refresh).toHaveBeenCalledWith(local.id);
    expect(screen.getByText("Local-only project")).toBeTruthy();
  });

  it("shows issues and PRs once the project is connected, without a reload", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const { queryClient } = renderWithClient(<LiveGithubTab projectId={local.id} />, client, {
      withRouter: true,
    });
    client.refreshProject = async () => {
      serverEvent(queryClient, connected);
      return response({
        project: connected,
        outcome: "github_connected",
        changed: true,
        message: "Connected to octo/notes-cli",
      });
    };

    fireEvent.click(await screen.findByRole("button", { name: /Check again/ }));
    expect(await screen.findByTestId("project-github")).toBeTruthy();
    expect(screen.queryByText("Local-only project")).toBeNull();
    expect(success).toHaveBeenCalledWith("Connected to octo/notes-cli");
    success.mockRestore();
  });

  it("meets the dark factory's GitHub requirement after checking again", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const { queryClient } = renderWithClient(<LiveAutonomy projectId={local.id} />, client, {
      withRouter: true,
    });
    client.refreshProject = async () => {
      serverEvent(queryClient, connected);
      return response({ project: connected, outcome: "github_connected", changed: true });
    };
    const githubRequirement = () =>
      within(screen.getByTestId("mode-requirements")).getAllByRole("listitem")[0];

    await screen.findByTestId("mode-requirements");
    expect(githubRequirement()?.getAttribute("data-ok")).toBe("false");
    expect(githubRequirement()?.textContent).toContain("no GitHub remote");
    fireEvent.click(
      within(githubRequirement() as HTMLElement).getByRole("button", { name: /Check again/ }),
    );
    await waitFor(() => {
      expect(githubRequirement()?.getAttribute("data-ok")).toBe("true");
      expect(githubRequirement()?.textContent).toContain("(octo/notes-cli)");
    });
    expect(screen.queryByRole("button", { name: /Check again/ })).toBeNull();
    success.mockRestore();
  });

  it("warns about a missing remote and lets the user make the project local-only", async () => {
    const client = createMockClient();
    const warned: Project = {
      ...connected,
      remoteWarning: {
        code: "github_remote_missing",
        remoteUrl: null,
        detectedAt: local.createdAt,
      },
    };
    const { queryClient } = renderWithClient(<LiveGithubTab projectId={local.id} />, client, {
      withRouter: true,
    });
    await screen.findByText("Local-only project"); // the snapshot is loaded
    serverEvent(queryClient, warned);
    const disconnect = vi.fn(async () => {
      serverEvent(queryClient, local);
      return { project: local };
    });
    client.disconnectGithub = disconnect;

    const banner = await screen.findByTestId("remote-warning");
    expect(banner.textContent).toContain("octo/notes-cli");
    fireEvent.click(screen.getByRole("button", { name: "Make local-only" }));
    expect(await screen.findByText("Local-only project")).toBeTruthy();
    expect(disconnect).toHaveBeenCalledWith(local.id);
  });
});
