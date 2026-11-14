import { describe, expect, it } from "vitest";
import { formContent, formFields, formQuestions, LEAVE_EMPTY } from "../src/codex/elicitation-form";
import type { McpElicitationSchema } from "../src/codex/protocol/v2";

/** Reading an MCP server's form answers (#235): each field type, valid, normalised and not. */
describe("formContent", () => {
  const schema = {
    type: "object",
    properties: {
      amount: { type: "number", title: "Amount" },
      count: { type: "integer", title: "Count" },
      notify: { type: "boolean", title: "Notify" },
      target: { type: "string", title: "Target", enum: ["stg", "prod"] },
      regions: { type: "array", title: "Regions", items: { type: "string", enum: ["eu", "us"] } },
      note: { type: "string", title: "Note" },
    },
  } as unknown as McpElicitationSchema;
  const fields = formFields(schema);
  /** The content for one field's answer, or its problem line. */
  const read = (id: string, ...answer: string[]) => {
    const result = formContent(fields, { [id]: answer });
    return "content" in result ? result.content[id] : result.problems.join("\n");
  };

  it("marks number fields with their format, so the card can check them", () => {
    const questions = formQuestions("deploy", "Fill this in", fields);
    expect(questions.map((q) => q.format)).toEqual([
      "number",
      "integer",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(questions[1]?.question).toBe("Count (a whole number)");
  });

  it("reads numbers as people write them", () => {
    expect(read("amount", "2.5")).toBe(2.5);
    expect(read("amount", " -3 ")).toBe(-3);
    expect(read("amount", "1,000")).toBe(1000);
    expect(read("amount", "1 000 000.5")).toBe(1000000.5);
    expect(read("count", "1,000")).toBe(1000);
    expect(read("count", "2.0")).toBe(2);
  });

  it("reports a number it can't read instead of guessing", () => {
    expect(read("amount", "five")).toBe(
      'Amount: "five" isn\'t a number. Type a number, like 2.5 or 1,000.',
    );
    for (const typed of ["10 items", "1,5", "1,00", "0x10", "Infinity", "$5"]) {
      expect(read("amount", typed)).toMatch(/^Amount: .* isn't a number/);
    }
    expect(read("count", "2.5")).toMatch(/^Count: "2.5" isn't a whole number/);
  });

  it("reads yes and no in the usual ways", () => {
    for (const yes of ["Yes", "y", "TRUE"]) expect(read("notify", yes)).toBe(true);
    for (const no of ["No", "n", "false"]) expect(read("notify", no)).toBe(false);
    expect(read("notify", "maybe")).toBe('Notify: "maybe" isn\'t Yes or No.');
  });

  it("reads choices by label or value, and names the options when neither matches", () => {
    expect(read("target", "prod")).toBe("prod");
    expect(read("target", "moon")).toBe(
      'Target: "moon" isn\'t one of the options. Pick one of: stg, prod.',
    );
    expect(read("regions", "eu", "us")).toEqual(["eu", "us"]);
    expect(read("regions", "eu", "mars")).toMatch(/^Regions: "eu", "mars" aren't all options/);
  });

  it("takes any text, and lets optional fields be left empty", () => {
    expect(read("note", "Ship it\nafter lunch")).toBe("Ship it\nafter lunch");
    expect(formContent(fields, { amount: [LEAVE_EMPTY], note: [] })).toEqual({ content: {} });
  });
});
