import { z } from "zod";

/**
 * Typed answers to the questions of a form (an MCP server's elicitation, §11.2). The question
 * card checks a typed answer with these as the user types, and the provider reads it with the
 * same rules, so whatever the card lets through is what the server gets.
 */

/** What a typed answer must be: a number, or a whole number. */
export const AnswerFormat = z.enum(["number", "integer"]);
export type AnswerFormat = z.infer<typeof AnswerFormat>;

/** Thousands written with one separator between groups of three: "1,000", "1 000 000", "1_000". */
const GROUPED = /^[+-]?\d{1,3}([,_   ])\d{3}(?:\1\d{3})*(?:\.\d+)?$/;
/** A plain decimal number: "3", "-2.5", ".5", "1e3". No hex, no words, no units. */
const PLAIN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * The number a typed answer means, or undefined when it isn't one (or, for `integer`, isn't a
 * whole number). Thousands separators are understood ("1,000" is 1000); a comma that could be a
 * decimal point ("1,5") is not guessed at.
 */
export function parseNumberAnswer(text: string, format: AnswerFormat): number | undefined {
  const trimmed = text.trim();
  const plain = GROUPED.test(trimmed) ? trimmed.replace(/[,_   ]/g, "") : trimmed;
  if (!PLAIN.test(plain)) return undefined;
  const n = Number(plain);
  if (!Number.isFinite(n)) return undefined;
  return format === "integer" && !Number.isSafeInteger(n) ? undefined : n;
}

const YES = new Set(["yes", "y", "true", "on", "1"]);
const NO = new Set(["no", "n", "false", "off", "0"]);

/** "Yes", "y", "true" are true; "No", "n", "false" false; anything else undefined. */
export function parseYesNo(text: string): boolean | undefined {
  const word = text.trim().toLowerCase();
  return YES.has(word) ? true : NO.has(word) ? false : undefined;
}

/** What an answer of this format is, for hints and errors: "a number", "a whole number". */
export function answerFormatName(format: AnswerFormat): string {
  return format === "integer" ? "a whole number" : "a number";
}
