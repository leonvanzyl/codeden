import { describe, expect, it } from "vitest";
import { answerFormatName, Notice, parseNumberAnswer, parseYesNo, UserQuestionItem } from "../src";

describe("form answers", () => {
  it("reads numbers as people write them, and nothing else", () => {
    expect(parseNumberAnswer("2.5", "number")).toBe(2.5);
    expect(parseNumberAnswer(".5", "number")).toBe(0.5);
    expect(parseNumberAnswer("+3", "integer")).toBe(3);
    expect(parseNumberAnswer("1e3", "integer")).toBe(1000);
    expect(parseNumberAnswer("1,000", "integer")).toBe(1000);
    expect(parseNumberAnswer("-1,234,567.25", "number")).toBe(-1234567.25);
    expect(parseNumberAnswer("1 000", "number")).toBe(1000);
    expect(parseNumberAnswer("1_000", "number")).toBe(1000);
    // A comma that may be a decimal point, mixed separators, words, units, hex: not guessed.
    for (const text of ["1,5", "1,000 000", "1.000,5", "five", "10 items", "0x10", "", "1e999"]) {
      expect(parseNumberAnswer(text, "number")).toBeUndefined();
    }
    expect(parseNumberAnswer("2.5", "integer")).toBeUndefined();
    expect(parseNumberAnswer("9007199254740993", "integer")).toBeUndefined();
  });

  it("reads yes and no", () => {
    expect(["Yes", "y", "TRUE", "on", "1"].map(parseYesNo)).toEqual([true, true, true, true, true]);
    expect(["No", "n", "false", "off", "0"].map(parseYesNo)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(parseYesNo("maybe")).toBeUndefined();
    expect(answerFormatName("integer")).toBe("a whole number");
  });

  it("round-trips a form's number question and an MCP form's needs-input notice", () => {
    const item = {
      id: "question-1",
      kind: "user_question",
      status: "in_progress",
      requestId: "mcp-1",
      mcpServer: "deploy",
      questions: [
        {
          id: "budget",
          question: "Budget (a number)",
          options: [],
          multiSelect: false,
          allowFreeText: true,
          format: "number",
        },
      ],
    };
    expect(UserQuestionItem.parse(JSON.parse(JSON.stringify(item)))).toEqual(item);
    expect(() =>
      UserQuestionItem.parse({ ...item, questions: [{ ...item.questions[0], format: "date" }] }),
    ).toThrow();
    const notice = {
      id: "session.needs_input:inbox:s1:q",
      type: "session.needs_input",
      projectId: "p1",
      target: "pm",
      sessionId: "s1",
      title: "Needs input: Deploy",
      createdAt: "2026-11-14T10:00:00.000Z",
      deliveredAt: null,
      data: {
        sessionId: "s1",
        workKey: "request:deploy",
        purpose: "Deploy",
        startedBy: { kind: "pm" },
        inboxItemId: "inbox:s1:q",
        kind: "question",
        question: "deploy asks: Where should I deploy?",
        mcpServer: "deploy",
      },
    };
    expect(Notice.parse(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
  });
});
