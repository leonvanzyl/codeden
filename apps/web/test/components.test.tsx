import type { ItemOf, UserQuestion } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceButton } from "@/components/composer/voice-button";
import { ConflictCard } from "@/components/project/conflict-card";
import { ApprovalCard } from "@/components/thread/cards/approval-card";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { WorkGroup } from "@/components/thread/work/work-group";
import { createMockClient } from "@/lib/api/mock";
import { conflicts } from "@/lib/api/mock/fixtures/sessions";
import type { WorkEntry } from "@/lib/transcript/timeline";
import type { SpeechToText } from "@/lib/voice/engines";
import { renderWithClient } from "./utils";

const approval: ItemOf<"approval_request"> = {
  id: "ap",
  kind: "approval_request",
  status: "in_progress",
  requestId: "req-1",
  action: "git_destructive",
  title: "Force push to main",
  reason: "Rewrites history",
  command: "git push --force",
  options: ["allow_once", "allow_session", "deny"],
};

describe("ApprovalCard", () => {
  it("sends the chosen decision", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<ApprovalCard item={approval} sessionId="s1" />, client);
    expect(screen.getByText("Force push to main")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Always allow this session/ }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-1", {
        kind: "approval",
        decision: "allow_session",
      }),
    );
  });

  it("shows the decision once resolved", () => {
    renderWithClient(
      <ApprovalCard item={{ ...approval, status: "declined", decision: "deny" }} sessionId="s1" />,
    );
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});

describe("ApprovalCard for a plan", () => {
  const planApproval: ItemOf<"approval_request"> = {
    id: "ap-plan",
    kind: "approval_request",
    status: "in_progress",
    requestId: "req-plan",
    action: "plan",
    title: "Approve the plan and start implementing",
    options: ["allow_once", "deny"],
  };

  it("approves the plan", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<ApprovalCard item={planApproval} sessionId="s1" />, client);
    expect(screen.getByText("Plan ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Approve plan/ }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-plan", {
        kind: "approval",
        decision: "allow_once",
      }),
    );
  });

  it("keeps planning with feedback", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<ApprovalCard item={planApproval} sessionId="s1" />, client);
    fireEvent.click(screen.getByRole("button", { name: /Keep planning/ }));
    fireEvent.change(screen.getByLabelText("Feedback on the plan"), {
      target: { value: "Split step 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Keep planning/ }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-plan", {
        kind: "approval",
        decision: "deny",
        message: "Split step 2",
      }),
    );
  });

  it("shows the plan in the inbox and the outcome once answered", () => {
    renderWithClient(
      <ApprovalCard item={planApproval} sessionId="s1" compact plan={`## Plan\n\n1. Do x`} />,
    );
    expect(screen.getByText("Do x")).toBeTruthy();
    renderWithClient(
      <ApprovalCard
        item={{ ...planApproval, status: "completed", decision: "allow_once" }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Plan approved")).toBeTruthy();
    renderWithClient(
      <ApprovalCard
        item={{ ...planApproval, status: "declined", decision: "deny" }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Kept planning")).toBeTruthy();
  });
});

describe("QuestionCard", () => {
  it("collects options and free text, then answers", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    const item: ItemOf<"user_question"> = {
      id: "q",
      kind: "user_question",
      status: "in_progress",
      requestId: "req-q",
      questions: [
        {
          id: "a",
          question: "Strategy?",
          options: [{ label: "Backoff" }, { label: "Fixed" }],
          multiSelect: false,
          allowFreeText: false,
        },
        { id: "b", question: "Then?", options: [], multiSelect: false, allowFreeText: true },
      ],
    };
    renderWithClient(<QuestionCard item={item} sessionId="s1" />, client);
    const send = screen.getByRole("button", { name: "Send answer" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Backoff/ }));
    fireEvent.change(screen.getByPlaceholderText(/your own answer/), {
      target: { value: "Dead-letter it" },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-q", {
        kind: "answer",
        answers: { a: ["Backoff"], b: ["Dead-letter it"] },
      }),
    );
  });

  const LONG_ANSWER =
    "I'm not sure. My concern is that we're going to have an infinite amount of worktrees taking up space on disk if every retry spins up its own session, so whatever we pick should cap the number of attempts and clean up after itself.";
  const retry: UserQuestion = {
    id: "a",
    question: "How should failed webhooks be retried?",
    options: [{ label: "Backoff" }, { label: "Fixed" }],
    multiSelect: false,
    allowFreeText: true,
  };
  const exhausted: UserQuestion = {
    id: "d",
    question: "What should happen once retries are exhausted?",
    options: [{ label: "Dead-letter table" }, { label: "Inbox alert" }, { label: "Email on-call" }],
    multiSelect: true,
    allowFreeText: true,
  };
  const answered = (
    questions: UserQuestion[],
    answers: Record<string, string[]>,
  ): ItemOf<"user_question"> => ({
    id: "q",
    kind: "user_question",
    status: "completed",
    requestId: "req-q",
    questions,
    answers,
  });

  /** Classes on `el` or its ancestors (up to the rendered card) that stop text from wrapping. */
  const noWrapClasses = (el: HTMLElement, container: HTMLElement) => {
    const found: string[] = [];
    for (let node: HTMLElement | null = el; node && node !== container; node = node.parentElement) {
      for (const c of node.classList) {
        if (["shrink-0", "whitespace-nowrap", "text-nowrap", "truncate"].includes(c)) found.push(c);
      }
    }
    return found;
  };

  afterEach(() => vi.restoreAllMocks());

  it("says when the project manager answered", () => {
    renderWithClient(
      <QuestionCard
        item={{ ...answered([retry], { a: ["Backoff"] }), decidedBy: "pm" }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Answered by the project manager")).toBeTruthy();
  });

  it("wraps a long free-text answer instead of squeezing the question", () => {
    const { container } = renderWithClient(
      <QuestionCard item={answered([retry], { a: [LONG_ANSWER] })} sessionId="s1" />,
    );
    const question = screen.getByText("How should failed webhooks be retried?");
    const answer = screen.getByText(LONG_ANSWER);
    expect(noWrapClasses(question, container)).toEqual([]);
    expect(noWrapClasses(answer, container)).toEqual([]);
    const block = answer.closest("p");
    expect(block?.className).toContain("whitespace-pre-wrap");
    expect(block?.className).toContain("wrap-break-word");
    // Nothing is clamped in jsdom, so there is nothing to expand.
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("lists picked options, then a typed answer on its own line", () => {
    renderWithClient(
      <QuestionCard
        item={answered([retry, exhausted], {
          a: ["Backoff"],
          d: ["Dead-letter table", "Inbox alert", "Also log it\nwith the payload"],
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Backoff")).toBeTruthy();
    const picked = screen.getByText("Dead-letter table");
    expect(screen.getByText("Inbox alert")).toBeTruthy();
    expect(screen.getByText("Also log it with the payload")).toBeTruthy();
    expect(picked.closest("p")?.textContent).toBe(
      "Dead-letter table, Inbox alert\nAlso log it\nwith the payload",
    );
  });

  it("shows a dash for a question left unanswered", () => {
    renderWithClient(<QuestionCard item={answered([retry], {})} sessionId="s1" />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("clamps long text with a toggle to show all of it", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(120);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(60);
    renderWithClient(
      <QuestionCard item={answered([retry], { a: [LONG_ANSWER] })} sessionId="s1" />,
    );
    const block = screen.getByText(LONG_ANSWER).closest("p");
    expect(block?.className).toContain("line-clamp-4");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(block?.className).not.toContain("line-clamp");
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(block?.className).toContain("line-clamp-4");
  });

  it("wraps a long question and option label while it waits for an answer", () => {
    const label = `Dead-letter table (${"billing_webhook_dead_letters_".repeat(6)})`;
    const question = `${"Keep in mind that providers resend the same event id days later. ".repeat(4)}What then?`;
    const { container } = renderWithClient(
      <QuestionCard
        item={{
          id: "q",
          kind: "user_question",
          status: "in_progress",
          requestId: "req-q",
          questions: [{ ...exhausted, header: "After retries", question, options: [{ label }] }],
        }}
        sessionId="s1"
      />,
    );
    // The header chip flows inline with the question text rather than in a squeezed column.
    expect(screen.getByText("After retries").parentElement?.textContent).toContain("What then?");
    const option = screen.getByText(label);
    expect(noWrapClasses(option, container)).toEqual([]);
    expect(option.closest(".wrap-break-word")).toBeTruthy();
  });
});

describe("WorkGroup", () => {
  const entries: WorkEntry[] = [
    {
      id: "1",
      kind: "tool_call",
      toolKind: "file_read",
      status: "completed",
      toolName: "Read",
      path: "src/a.ts",
    },
    {
      id: "2",
      kind: "tool_call",
      toolKind: "command",
      status: "completed",
      toolName: "Bash",
      command: "pnpm test",
      output: { text: "ok", truncated: false },
      exitCode: 0,
    },
  ];

  it("collapses into a summary and expands on click", () => {
    renderWithClient(<WorkGroup entries={entries} live={false} />);
    expect(screen.getByText("Ran 1 command and read 1 file")).toBeTruthy();
    expect(screen.queryByText("src/a.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Ran 1 command/ }));
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("summarises a long MCP result and keeps the full output in the details", () => {
    const output = JSON.stringify({
      issue: { projectId: "a72f9074", title: "Discover the model list", trace: "c0de".repeat(500) },
    });
    const mcp: WorkEntry = {
      id: "m",
      kind: "tool_call",
      toolKind: "mcp",
      status: "completed",
      toolName: "mcp__codeden__triage_issue",
      server: "codeden",
      tool: "triage_issue",
      title: "codeden: triage_issue",
      output: { text: output, truncated: false },
      durationMs: 12,
    };
    renderWithClient(<WorkGroup entries={[mcp]} live={false} />);
    const row = screen.getByRole("button", { name: /codeden: triage_issue/ });
    expect(row.textContent).toContain("Discover the model list");
    expect(row.textContent).not.toContain("projectId");
    fireEvent.click(row);
    expect(screen.getByText(output)).toBeTruthy();
  });

  it("shows the running step while live", () => {
    const live: WorkEntry[] = [
      ...entries,
      {
        id: "3",
        kind: "tool_call",
        toolKind: "command",
        status: "in_progress",
        toolName: "Bash",
        command: "pnpm build",
      },
    ];
    renderWithClient(<WorkGroup entries={live} live />);
    expect(screen.getAllByText("pnpm build").length).toBeGreaterThan(0);
  });
});

describe("ConflictCard", () => {
  it("offers wait, join, skip and force", async () => {
    const client = createMockClient();
    const conflict = conflicts[0];
    if (!conflict) throw new Error("fixture missing");
    const resolve = vi
      .spyOn(client, "resolveConflict")
      .mockResolvedValue({ conflict, result: { status: "skipped" } });
    renderWithClient(<ConflictCard conflict={conflict} />, client, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: /Join/ }));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith("cf-audit", {
        resolution: "join",
        sessionId: "s-audit",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Force/ }));
    const start = screen.getByRole("button", { name: "Start anyway" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });
});

describe("VoiceButton", () => {
  it("is disabled when speech recognition is unsupported", () => {
    const engine: SpeechToText = { supported: false, start: vi.fn(), stop: vi.fn() };
    renderWithClient(<VoiceButton baseText="" onText={() => {}} engine={engine} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("streams dictated text after the existing draft", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = { supported: true, start: (o) => (handlers = o), stop: vi.fn() };
    const onText = vi.fn();
    renderWithClient(<VoiceButton baseText="Fix" onText={onText} engine={engine} />);
    fireEvent.click(screen.getByRole("button"));
    handlers?.onText("the flaky test", true);
    expect(onText).toHaveBeenCalledWith("Fix the flaky test");
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });
});
