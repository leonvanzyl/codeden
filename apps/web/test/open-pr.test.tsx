import type { Project, QueuedMessage, Session, Snapshot } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitBar } from "@/components/workbench/git-bar";
import { GitHubPanel } from "@/components/workbench/github-panel";
import { PushToastPrAction } from "@/components/workbench/open-pr-controls";
import type { CodeDenClient } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { projects } from "@/lib/api/mock/fixtures/world";
import {
  canAskForPullRequest,
  latestUserMessage,
  OPEN_PR_PROMPT,
  pullRequestOffer,
} from "@/lib/pull-request";
import { withCreatedProject } from "@/lib/snapshot-reducer";
import { emptyTranscript } from "@/lib/transcript/reducer";
import { usePrRequestsStore } from "@/stores/pr-requests";
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

describe("pullRequestOffer", () => {
  const offer = (over: Partial<Parameters<typeof pullRequestOffer>[0]> = {}) =>
    pullRequestOffer({
      session,
      project: github,
      pr: null,
      connected: true,
      queue: [],
      latest: null,
      asked: undefined,
      ...over,
    });
  const queued = (text: string): QueuedMessage => ({
    id: "q-1",
    sessionId: session.id,
    input: { text, attachments: [] },
    from: "user",
    createdAt: session.createdAt,
  });

  it("offers Open PR when the session can ask and nothing is in progress", () => {
    expect(offer()).toEqual({ canAsk: true, requested: null, pr: null });
    expect(offer({ queue: [queued("Also add a test")] }).canAsk).toBe(true);
  });

  it("says requested, not Open PR, while the request is queued behind the running turn", () => {
    expect(offer({ queue: [queued("Fix the typo"), queued(OPEN_PR_PROMPT)] })).toEqual({
      canAsk: false,
      requested: "queued",
      pr: null,
    });
  });

  it("says requested while the turn that carries it runs, and offers again once it ended", () => {
    const latest = { id: "u-2", asksForPr: true, running: true };
    expect(offer({ latest })).toEqual({ canAsk: false, requested: "sent", pr: null });
    expect(offer({ latest: { ...latest, running: false } }).canAsk).toBe(true);
    expect(offer({ latest: { ...latest, asksForPr: false } }).canAsk).toBe(true);
  });

  it("says requested from the press until the server shows the request", () => {
    const before = { id: "u-1", asksForPr: false, running: false };
    expect(offer({ latest: before, asked: { after: "u-1" } }).requested).toBe("sent");
    expect(offer({ latest: null, asked: { after: null } }).requested).toBe("sent");
    // The transcript moved on: the turn that carried it decides, and it has ended.
    const ended = { id: "u-2", asksForPr: true, running: false };
    expect(offer({ latest: ended, asked: { after: "u-1" } }).canAsk).toBe(true);
  });

  it("shows the open PR instead, and nothing when GitHub is disconnected", () => {
    expect(offer({ pr: pr("open"), queue: [queued(OPEN_PR_PROMPT)] })).toEqual({
      canAsk: false,
      requested: null,
      pr: pr("open"),
    });
    expect(offer({ connected: false, queue: [queued(OPEN_PR_PROMPT)] })).toEqual({
      canAsk: false,
      requested: null,
      pr: null,
    });
  });

  it("reads the root thread's latest user message and its turn from the transcript", () => {
    const t = emptyTranscript(session.id);
    t.rootThreadId = "th-root";
    t.threads["th-root"] = {
      id: "th-root",
      parentThreadId: null,
      parentItemId: null,
      title: null,
      agentType: null,
      itemIds: ["u-1", "a-1", "u-2", "a-2"],
      turnIds: ["t-1", "t-2"],
    };
    const turn = (id: string, status: "running" | "completed") => ({
      id,
      threadId: "th-root",
      status,
      startedAt: session.createdAt,
      completedAt: null,
      error: null,
    });
    t.turns = { "t-1": turn("t-1", "completed"), "t-2": turn("t-2", "running") };
    const user = (id: string, text: string, turnId: string) => ({
      item: {
        id,
        status: "completed" as const,
        kind: "user_message" as const,
        input: { text, attachments: [] },
      },
      turnId,
      threadId: "th-root",
    });
    const reply = (id: string, turnId: string) => ({
      item: { id, status: "completed" as const, kind: "assistant_message" as const, text: "On it" },
      turnId,
      threadId: "th-root",
    });
    t.items = {
      "u-1": user("u-1", "Add rate limiting", "t-1"),
      "a-1": reply("a-1", "t-1"),
      "u-2": user("u-2", OPEN_PR_PROMPT, "t-2"),
      "a-2": reply("a-2", "t-2"),
    };
    expect(latestUserMessage(t)).toEqual({ id: "u-2", asksForPr: true, running: true });
    expect(latestUserMessage(undefined)).toBeNull();
  });
});

describe("Issue / PR tab: Open pull request", () => {
  beforeEach(() => usePrRequestsStore.setState({ asked: {} }));

  /** A client for `subject`, whose queue (as the server reports it) holds `queue`. */
  function clientFor(subject: Session, queue: QueuedMessage[] = []) {
    const base = createMockClient();
    const sendMessage = vi.fn(async (..._args: Parameters<CodeDenClient["sendMessage"]>) => {});
    const client: CodeDenClient = {
      ...base,
      sendMessage,
      queue: { ...base.queue, list: async () => queue },
      getSnapshot: async () => {
        const s: Snapshot = await base.getSnapshot();
        return { ...s, sessions: [...s.sessions, subject] };
      },
    };
    return { client, sendMessage };
  }

  function renderPanel(subject: Session, queue: QueuedMessage[] = []) {
    const { client, sendMessage } = clientFor(subject, queue);
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

  it("asks only once: a second press before GitHub reports the PR sends nothing more", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const { sendMessage } = renderPanel(session);

    fireEvent.click(await screen.findByRole("button", { name: /Open pull request/ }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    // The request went through and the agent hasn't opened the PR yet.
    const requested = await screen.findByRole("button", { name: /PR requested/ });
    expect((requested as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
    fireEvent.click(requested);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    success.mockRestore();
  });

  it("asks only once across the Git bar, the Issue / PR tab and the Push toast", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const { client, sendMessage } = clientFor(session);
    renderWithClient(
      <>
        <GitBar sessionId={session.id} title="Rate limiting" />
        <GitHubPanel sessionId={session.id} />
        <PushToastPrAction sessionId={session.id} />
      </>,
      client,
    );

    await screen.findByRole("button", { name: /Open pull request/ });
    fireEvent.click(await screen.findByTitle("Ask the agent to open a pull request for this work"));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    const requested = await screen.findAllByRole("button", { name: /PR requested/ });
    expect(requested).toHaveLength(3);
    for (const b of requested) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Open PR$|Open pull request/ })).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    success.mockRestore();
  });

  it("says the request is queued behind the running turn, also after a reload", async () => {
    const { sendMessage } = renderPanel(session, [
      {
        id: "q-pr",
        sessionId: session.id,
        input: { text: OPEN_PR_PROMPT, attachments: [] },
        from: "user",
        createdAt: session.createdAt,
      },
    ]);
    expect(await screen.findByText(/queued behind the running turn/)).toBeTruthy();
    const requested = screen.getByRole("button", { name: /PR requested/ });
    expect((requested as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("explains, without the button, when the session can't open one", async () => {
    renderPanel({ ...session, autonomy: "read_only" });
    expect(await screen.findByText("No issue or PR linked")).toBeTruthy();
    expect(screen.getByText(/ask the agent to open a pull request/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
  });
});
