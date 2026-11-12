import { describe, expect, it } from "vitest";
import {
  lineComment,
  sameComments,
  tomlComments,
} from "../src/services/agent-config/toml-comments";

describe("TOML comments", () => {
  it("finds whole-line comments and comments after values, outside strings", () => {
    const text = [
      "# head",
      'a = "x # not a comment" # after a basic string',
      "b = 'it''s' # after literal strings",
      'c = "esc \\" # still a string" # after an escaped quote',
      'd = """',
      "# inside a multi-line string",
      '""" # after a multi-line string',
      "e = '''",
      "# inside a literal multi-line string",
      "'''",
      '"key # quoted" = 1 # after a quoted key',
      "  # indented\r",
    ].join("\n");
    expect(tomlComments(text).map((c) => c.text)).toEqual([
      "# head",
      "# after a basic string",
      "# after literal strings",
      "# after an escaped quote",
      "# after a multi-line string",
      "# after a quoted key",
      "# indented",
    ]);
    expect(lineComment("enabled = false # why")).toBe("# why");
    expect(lineComment('name = "a#b"')).toBeNull();
  });

  it("compares the comments of two texts, wherever they sit", () => {
    expect(sameComments("a = 1 # x\n# y\n", "# y\n# x\n")).toBe(true);
    expect(sameComments("a = 1 # x\n", "a = 1\n")).toBe(false);
    expect(sameComments("# x\n", "# x\n# x\n")).toBe(false);
    expect(sameComments('a = "#"\n', "a = 1\n")).toBe(true);
  });
});
