import type { Project, Session, Snapshot } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { GitHubPanel } from "@/components/workbench/github-panel";
import type { CodeDenClient } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { projects } from "@/lib/api/mock/fixtures/world";
import { canAskForPullRequest, OPEN_PR_PROMPT } from "@/lib/pull-request";
import { withCreatedProject } from "@/lib/snapshot-reducer";
import { renderWithClient } from "./utils";

const github = projects.find((p) => p.id === "p-billing") as Project;
const local = projects.find((p) => p.id === "p-notes") as Project;

/** A session the user started in a GitHub project, on its own branch, with no PR yet. */
const session = makeSession({
  id: "s-ask-pr",
  projectId: github.id,
  role: "agent",
  status: "idle",
  provider: "claude",
  purpose: "Add rate limiting to the invoices API",
  workKey: "ask:rate-limit",
  cwd: "C:\\wt\\billing\\rate-limit",
  worktreePath: "C:\\wt\\billing\\rate-limit",
  branch: "codeden/rate-limit",
  baseBranch: "main",
});
const pr = (state: "draft" | "open" | "closed" | "merged") => ({
  number: 7,
  url: "https://github.com/hearth-co/billing-api/pull/7",
  state,
});

describe("canAskForPullRequest", () => {
  it("offers a PR for a user's session on its own branch in a GitHub project", () => {
    expect(canAskForPullRequest(session, github)).toBe(true);
  });

  it("needs a GitHub project", () => {
    expect(canAskForPullRequest(session, { ...local })).toBe(false);
    expect(canAskForPullRequest(session, undefined)).toBe(false);
    expect(canAskForPullRequest(undefined, github)).toBe(false);
  });

  it("leaves sessions CodeDen started to open their own PRs", () => {
    for (const startedBy of [
      { kind: "pm", id: "s-pm" },
      { kind: "orchestrator" },
      { kind: "automation", id: "a-1" },
    ] as Session["startedBy"][]) {
      expect(canAskForPullRequest({ ...session, startedBy }, github)).toBe(false);
    }
    expect(canAskForPullRequest({ ...session, role: "pm" }, github)).toBe(false);
  });

  it("needs a session that can push: not read-only, not archived", () => {
    expect(canAskForPullRequest({ ...session, autonomy: "read_only" }, github)).toBe(false);
    expect(canAskForPullRequest({ ...session, archivedAt: session.createdAt }, github)).toBe(false);
  });

  it("needs the session's own branch, not its base", () => {
    expect(canAskForPullRequest({ ...session, worktreePath: null }, github)).toBe(false);
    expect(canAskForPullRequest({ ...session, branch: null }, github)).toBe(false);
    expect(canAskForPullRequest({ ...session, branch: "main" }, github)).toBe(false);
  });

  it("stops offering once a PR is open or a draft, and offers again after it closed", () => {
    expect(canAskForPullRequest({ ...session, pr: pr("open") }, github)).toBe(false);
    expect(canAskForPullRequest({ ...session, pr: pr("draft") }, github)).toBe(false);
    expect(canAskForPullRequest({ ...session, pr: pr("merged") }, github)).toBe(true);
    expect(canAskForPullRequest({ ...session, pr: pr("closed") }, github)).toBe(true);
    // GitHub's live state wins over the copy recorded on the session.
    expect(canAskForPullRequest(session, github, pr("open"))).toBe(false);
  });
});

describe("withCreatedProject", () => {
  it("adds a just-created project once, keeping the live event's copy when it came first", async () => {
    const snap = await createMockClient().getSnapshot();
    const created: Project = { ...local, id: "p-new", name: "new-app", slug: "new-app" };
    const added = withCreatedProject(snap, created);
    expect(added.projects.filter((p) => p.id === "p-new")).toHaveLength(1);
    expect(added.seq).toBe(snap.seq);
    const fromEvent = { ...created, name: "renamed by the server" };
    const live = { ...snap, projects: [...snap.projects, fromEvent] };
    expect(withCreatedProject(live, created)).toBe(live);
  });
});

describe("Issue / PR tab: Open pull request", () => {
  function renderPanel(subject: Session) {
    const base = createMockClient();
    const sendMessage = vi.fn(async (..._args: Parameters<CodeDenClient["sendMessage"]>) => {});
    const client: CodeDenClient = {
      ...base,
      sendMessage,
      getSnapshot: async () => {
        const s: Snapshot = await base.getSnapshot();
        return { ...s, sessions: [...s.sessions, subject] };
      },
    };
    renderWithClient(<GitHubPanel sessionId={subject.id} />, client);
    return { sendMessage };
  }

  it("asks the session's agent to open a pull request, queued behind a running turn", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const { sendMessage } = renderPanel(session);

    fireEvent.click(await screen.findByRole("button", { name: /Open pull request/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(session.id, { text: OPEN_PR_PROMPT }, "queue");
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Asked the agent to open a pull request"),
    );
    success.mockRestore();
  });

  it("explains, without the button, when the session can't open one", async () => {
    renderPanel({ ...session, autonomy: "read_only" });
    expect(await screen.findByText("No issue or PR linked")).toBeTruthy();
    expect(screen.getByText(/ask the agent to open a pull request/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
  });
});
