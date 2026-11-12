import { describe, expect, it } from "vitest";
import { type Item, MAX_SEARCHABLE_CHARS, searchableText } from "../src";

const base = { id: "i1", status: "completed" as const };
const tool = { ...base, kind: "tool_call" as const, toolName: "Tool" };

describe("searchable item text", () => {
  it.each<[string, Item, string]>([
    [
      "user message",
      { ...base, kind: "user_message", input: { text: "Fix the cart", attachments: [] } },
      "Fix the cart",
    ],
    ["assistant message", { ...base, kind: "assistant_message", text: "Done." }, "Done."],
    ["plan", { ...base, kind: "plan", text: "1. Read\n2. Fix" }, "1. Read\n2. Fix"],
    [
      "command (title and command line)",
      {
        ...tool,
        toolKind: "command",
        title: "Run tests",
        command: "pnpm test",
        output: { text: "SECRET OUTPUT", truncated: false },
      },
      "Run tests\npnpm test",
    ],
    [
      "file edit (paths, not the diff)",
      {
        ...tool,
        toolKind: "file_edit",
        changes: [
          { path: "src/new.ts", change: "rename", previousPath: "src/old.ts", diff: "+DIFF" },
          { path: "src/cart.ts", change: "modify", diff: "-a\n+b" },
        ],
      },
      "src/old.ts\nsrc/new.ts\nsrc/cart.ts",
    ],
    ["file read", { ...tool, toolKind: "file_read", path: "README.md" }, "README.md"],
    [
      "search",
      { ...tool, toolKind: "search", query: "retryWebhook", path: "src" },
      "retryWebhook\nsrc",
    ],
    [
      "web",
      { ...tool, toolKind: "web", url: "https://example.com/docs", query: "fts5 trigram" },
      "https://example.com/docs\nfts5 trigram",
    ],
    ["mcp", { ...tool, toolKind: "mcp", server: "codeden", tool: "finish" }, "codeden finish"],
    [
      "browser",
      { ...tool, toolKind: "browser", action: "navigate", url: "http://localhost:5173" },
      "navigate\nhttp://localhost:5173",
    ],
    ["other tool", { ...tool, toolKind: "other", toolName: "TodoWrite" }, "TodoWrite"],
    [
      "subagent",
      {
        ...base,
        kind: "subagent",
        childThreadId: "t2",
        agentType: "code-reviewer",
        description: "Review the cart hook",
        prompt: "Look at useCart",
        summary: "Two issues found",
      },
      "code-reviewer\nReview the cart hook\nLook at useCart\nTwo issues found",
    ],
    [
      "question and answers",
      {
        ...base,
        kind: "user_question",
        requestId: "r1",
        questions: [
          {
            id: "q1",
            header: "Database",
            question: "Which database?",
            options: [],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
        answers: { q1: ["Postgres"] },
      },
      "Database\nWhich database?\nPostgres",
    ],
    [
      "approval",
      {
        ...base,
        kind: "approval_request",
        requestId: "r1",
        action: "command",
        title: "Run a command",
        reason: "Network access",
        command: "curl example.com",
        paths: ["/etc/hosts"],
        options: ["allow_once", "deny"],
      },
      "Run a command\nNetwork access\ncurl example.com\n/etc/hosts",
    ],
    [
      "notice",
      { ...base, kind: "notice", level: "info", message: "Context compacted" },
      "Context compacted",
    ],
    [
      "error",
      {
        ...base,
        kind: "error",
        error: { kind: "fatal", message: "Rate limited", retryable: false },
      },
      "Rate limited",
    ],
    ["reasoning (not indexed)", { ...base, kind: "reasoning", text: "thinking…" }, ""],
    [
      "todo list (not indexed)",
      { ...base, kind: "todo_list", todos: [{ text: "Fix", status: "pending" }] },
      "",
    ],
    [
      "follow-ups (not indexed)",
      { ...base, kind: "followups", source: "agent", suggestions: [{ prompt: "Add tests" }] },
      "",
    ],
  ])("%s", (_label, item, expected) => {
    expect(searchableText(item)).toBe(expected);
  });

  it("caps the text", () => {
    const long: Item = { ...base, kind: "assistant_message", text: "x".repeat(20_000) };
    expect(searchableText(long)).toHaveLength(MAX_SEARCHABLE_CHARS);
  });
});
