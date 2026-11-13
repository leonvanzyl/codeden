import type { ItemOf, UserQuestion } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceButton } from "@/components/composer/voice-button";
import { ConflictCard } from "@/components/project/conflict-card";
import { ApprovalCard } from "@/components/thread/cards/approval-card";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { SubagentCard } from "@/components/thread/cards/subagent-card";
import { WorkGroup } from "@/components/thread/work/work-group";
import { usageKeys } from "@/components/usage/api";
import { mockUsageApi } from "@/components/usage/mock-data";
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
    // The agent's own questions are answered, not dismissed.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
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

  it("lets the user dismiss an MCP server's form without filling it in", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    const item: ItemOf<"user_question"> = {
      id: "q",
      kind: "user_question",
      status: "in_progress",
      requestId: "req-form",
      mcpServer: "deploy",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "deploy asks: Where should I deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
          multiSelect: false,
          allowFreeText: false,
        },
        {
          id: "token",
          question: "Deploy token",
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };
    renderWithClient(<QuestionCard item={item} sessionId="s1" />, client);
    expect(screen.getByText(/Your answers go to deploy/)).toBeTruthy();
    // Nothing is filled in, so the only way on is to dismiss it.
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("s1", "req-form", { kind: "cancel" }));
    expect(respond).toHaveBeenCalledTimes(1);
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
    renderWithClient(<WorkGroup sessionId="s1" entries={entries} live={false} />);
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
    renderWithClient(<WorkGroup sessionId="s1" entries={[mcp]} live={false} />);
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
    renderWithClient(<WorkGroup sessionId="s1" entries={live} live />);
    expect(screen.getAllByText("pnpm build").length).toBeGreaterThan(0);
  });
});

/** A subagent card whose item the test can replace (`bind` hands out the setter). */
function LiveSubagentCard({
  initial,
  bind,
}: {
  initial: ItemOf<"subagent">;
  bind: (replace: (item: ItemOf<"subagent">) => void) => void;
}) {
  const [item, setItem] = useState(initial);
  bind(setItem);
  return <SubagentCard item={item} sessionId="s1" />;
}

describe("SubagentCard", () => {
  const sub: ItemOf<"subagent"> = {
    id: "sa",
    kind: "subagent",
    status: "completed",
    childThreadId: "s1:thread-sa",
    agentType: "Explore",
    description: "Find the flaky test",
    summary: "Found it in useCart.test.ts",
  };

  it("shows a finished subagent's figures beside its summary, in place of the steps", () => {
    const stats = { totalTokens: 48_213, toolUses: 23, durationMs: 72_000 };
    renderWithClient(<SubagentCard item={{ ...sub, stats }} sessionId="s1" />);
    const figures = screen.getByText("· 48.2k tokens · 23 tool calls · 1m 12s");
    expect(figures.getAttribute("title")).toBe(
      "48,213 tokens · 23 tool calls · 1m 12s (72,000 ms)",
    );
    // Same row as the summary, which truncates first.
    expect(figures.parentElement).toBe(screen.getByText(sub.summary ?? "").parentElement);
    expect(figures.className).toContain("shrink-0");
  });

  it("shows only the figures reported, each exact in the tooltip", () => {
    renderWithClient(
      <SubagentCard item={{ ...sub, stats: { durationMs: 4210 } }} sessionId="s1" />,
    );
    expect(screen.getByText("· 4.2s").getAttribute("title")).toBe("4.2s (4,210 ms)");
  });

  it("shows no stats while running or when the provider reported none", () => {
    const { unmount } = renderWithClient(<SubagentCard item={sub} sessionId="s1" />);
    expect(screen.queryByText(/tool call/)).toBeNull();
    unmount();
    const running = { ...sub, status: "in_progress" as const, stats: { totalTokens: 10 } };
    renderWithClient(<SubagentCard item={running} sessionId="s1" />);
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  describe("cost", () => {
    const usage = [
      {
        model: "claude-haiku-5-5",
        inputTokens: 1_200,
        outputTokens: 300,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 15_000,
      },
    ];
    const stats = { totalTokens: 48_213, toolUses: 23, durationMs: 72_000, usage };
    const priced = (costUsd: number, model = usage[0]) => ({
      sessionId: "s1",
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        estimatedCostUsd: 0,
        unpricedTurns: 0,
        turns: 0,
        sessions: 1,
        cacheHitRate: null,
      },
      billing: "subscription" as const,
      turns: [],
      subagents: [
        {
          itemId: "sa",
          costUsd,
          costSource: "estimated" as const,
          models: [
            {
              ...(model as (typeof usage)[number]),
              label: "Haiku 5.5",
              reasoningTokens: 0,
              costUsd,
              costSource: "estimated" as const,
            },
          ],
        },
      ],
    });
    afterEach(() => vi.restoreAllMocks());

    it("leads with what the finished run cost, explained per model in the tooltip", async () => {
      vi.spyOn(mockUsageApi, "session").mockResolvedValue(priced(0.42));
      renderWithClient(<SubagentCard item={{ ...sub, stats }} sessionId="s1" />);
      const figures = await screen.findByText("· ≈ $0.42 · 48.2k tokens · 23 tool calls · 1m 12s");
      expect(figures.getAttribute("title")).toBe(
        [
          "API-equivalent cost (estimated from list prices)",
          "Haiku 5.5: ≈ $0.42 · 1k input · 300 output · 40k cache reads · 15k cache writes",
          "48,213 tokens · 23 tool calls · 1m 12s (72,000 ms)",
        ].join("\n"),
      );
    });

    it("fetches the cost again when the card's figures are newer than what was priced", async () => {
      // Priced before the run's final output counts arrived, then again after.
      const session = vi
        .spyOn(mockUsageApi, "session")
        .mockResolvedValueOnce(priced(0.4, { ...usage[0], outputTokens: 3 } as never))
        .mockResolvedValue(priced(0.42));
      renderWithClient(<SubagentCard item={{ ...sub, stats }} sessionId="s1" />);
      expect(await screen.findByText(/≈ \$0\.42 · 48\.2k tokens/)).toBeTruthy();
      expect(session).toHaveBeenCalledTimes(2);
    });

    /** The card with an item the test replaces, as live events replace it. */
    function liveCard(initial: ItemOf<"subagent">) {
      let replace: (item: ItemOf<"subagent">) => void = () => {};
      const rendered = renderWithClient(
        <LiveSubagentCard
          initial={initial}
          bind={(set) => {
            replace = set;
          }}
        />,
      );
      return { ...rendered, update: (item: ItemOf<"subagent">) => act(() => replace(item)) };
    }
    const withUsage = (over: Partial<(typeof usage)[number]>) => {
      const entry = { ...(usage[0] as (typeof usage)[number]), ...over };
      return { item: { ...sub, stats: { ...stats, usage: [entry] } }, entry };
    };

    it("prices final figures that arrive while an older request is still running", async () => {
      const early = withUsage({ outputTokens: 1 });
      const final = withUsage({ outputTokens: 77 });
      let release: (value: ReturnType<typeof priced>) => void = () => {};
      const running = new Promise<ReturnType<typeof priced>>((resolve) => {
        release = resolve;
      });
      const session = vi
        .spyOn(mockUsageApi, "session")
        .mockResolvedValueOnce(priced(0.01, early.entry))
        .mockImplementationOnce(() => running)
        .mockResolvedValue(priced(0.02, final.entry));
      const { update, queryClient } = liveCard(early.item);
      expect(await screen.findByText(/≈ \$0\.010 · 48\.2k tokens/)).toBeTruthy();

      // Something else (the session header) fetches the session's usage again...
      void queryClient.invalidateQueries({ queryKey: usageKeys.session("s1") });
      await waitFor(() => expect(session).toHaveBeenCalledTimes(2));
      // ...and the run's final figures arrive before that request returns the old prices.
      update(final.item);
      release(priced(0.01, early.entry));

      expect(await screen.findByText(/≈ \$0\.020 · 48\.2k tokens/)).toBeTruthy();
      expect(session).toHaveBeenCalledTimes(3);
    });

    it("prices a correction that changes the model but not the token counts", async () => {
      const haiku = withUsage({ model: "claude-haiku-5-5" });
      const opus = withUsage({ model: "claude-opus-5-5" });
      const session = vi
        .spyOn(mockUsageApi, "session")
        .mockResolvedValueOnce(priced(0.42, haiku.entry))
        .mockResolvedValue(priced(1.5, opus.entry));
      const { update } = liveCard(haiku.item);
      expect(await screen.findByText(/≈ \$0\.42 · 48\.2k tokens/)).toBeTruthy();
      update(opus.item);
      expect(await screen.findByText(/≈ \$1\.50 · 48\.2k tokens/)).toBeTruthy();
      expect(session).toHaveBeenCalledTimes(2);
    });

    it("shows no cost while running, nor when nothing could be priced", async () => {
      const base = priced(0);
      const [cost] = base.subagents;
      if (!cost) throw new Error("fixture missing");
      const session = vi.spyOn(mockUsageApi, "session").mockResolvedValue({
        ...base,
        subagents: [
          {
            ...cost,
            costSource: "unpriced",
            models: cost.models.map((m) => ({ ...m, costSource: "unpriced" as const })),
          },
        ],
      });
      const running = { ...sub, status: "in_progress" as const, stats };
      const { unmount } = renderWithClient(<SubagentCard item={running} sessionId="s1" />);
      expect(screen.queryByText(/\$/)).toBeNull();
      expect(session).not.toHaveBeenCalled();
      unmount();
      renderWithClient(<SubagentCard item={{ ...sub, stats }} sessionId="s1" />);
      const figures = screen.getByText("· 48.2k tokens · 23 tool calls · 1m 12s");
      await waitFor(() =>
        expect(figures.getAttribute("title")).toContain(
          "Not priced: no price for claude-haiku-5-5",
        ),
      );
      expect(figures.textContent).not.toContain("$");
    });
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
