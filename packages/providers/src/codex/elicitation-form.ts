import {
  answerFormatName,
  parseNumberAnswer,
  parseYesNo,
  type UserQuestion,
} from "@codeden/contracts";
import type { JsonValue } from "./protocol/serde_json/JsonValue";
import type { McpElicitationPrimitiveSchema, McpElicitationSchema } from "./protocol/v2";

/**
 * An MCP server's form (the `requestedSchema` of an elicitation) as CodeDen questions, and the
 * answers back as the form's content. One question per field: choices become options, yes/no
 * fields Yes and No, text and numbers free text (numbers carry their `format`, which the card
 * checks). Optional fields can be left empty. Answers that don't fit their field are reported,
 * never sent as a refusal the user didn't give.
 */

/** One field of a form. */
export interface FormField {
  /** The property name: the key of its value in the content. */
  name: string;
  /** The question id (the name, unless it can't be one). */
  id: string;
  label: string;
  description?: string;
  required: boolean;
  type: "text" | "number" | "integer" | "boolean" | "choice" | "choices";
  /** Values and their labels, for `choice` and `choices`. */
  choices: { value: string; label: string }[];
}

/** The option that leaves an optional field empty. */
export const LEAVE_EMPTY = "Leave empty";
/** A form without fields is a confirmation: one question, accept or decline. */
export const CONFIRM_ID = "confirm";
export const ACCEPT = "Accept";
export const DECLINE = "Decline";

export function formFields(schema: McpElicitationSchema): FormField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, prop], i) =>
    prop ? [field(name, i, prop, required.has(name))] : [],
  );
}

function field(
  name: string,
  index: number,
  s: McpElicitationPrimitiveSchema,
  required: boolean,
): FormField {
  const description = s.description?.trim();
  const base = {
    name,
    id: name.length > 0 && name.length <= 200 ? name : `field-${index}`,
    label: s.title?.trim() || name,
    ...(description ? { description } : {}),
    required,
    choices: [],
  };
  if (s.type === "boolean") return { ...base, type: "boolean" };
  if (s.type === "number" || s.type === "integer") return { ...base, type: s.type };
  if (s.type === "array") {
    const items = s.items;
    const choices =
      "anyOf" in items
        ? items.anyOf.map((o) => ({ value: o.const, label: o.title }))
        : items.enum.map((value) => ({ value, label: value }));
    return { ...base, type: "choices", choices: unique(choices) };
  }
  if ("oneOf" in s) {
    return {
      ...base,
      type: "choice",
      choices: unique(s.oneOf.map((o) => ({ value: o.const, label: o.title }))),
    };
  }
  if ("enum" in s) {
    const names = "enumNames" in s ? s.enumNames : undefined;
    const choices = s.enum.map((value, i) => ({ value, label: names?.[i] ?? value }));
    return { ...base, type: "choice", choices: unique(choices) };
  }
  return { ...base, type: "text" };
}

/**
 * Labels are how answers come back, so each must name exactly one value: a repeated label (or
 * one that reads as {@link LEAVE_EMPTY}) gets its value added, then a number, until it is free.
 */
function unique(choices: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>([LEAVE_EMPTY]);
  return choices.map((c) => {
    const label = c.label.trim() || c.value;
    let free = seen.has(label) ? `${label} (${c.value})` : label;
    for (let n = 2; seen.has(free); n++) free = `${label} (${c.value}) ${n}`;
    seen.add(free);
    return { value: c.value, label: free };
  });
}

const isNumber = (f: FormField): f is FormField & { type: "number" | "integer" } =>
  f.type === "number" || f.type === "integer";

/** The form as questions; the first one carries the server's message. */
export function formQuestions(
  server: string,
  message: string,
  fields: FormField[],
): UserQuestion[] {
  const lead = `${server} asks: ${message.trim()}`;
  if (fields.length === 0) {
    return [
      {
        id: CONFIRM_ID,
        header: server,
        question: lead,
        options: [{ label: ACCEPT }, { label: DECLINE }],
        multiSelect: false,
        allowFreeText: false,
      },
    ];
  }
  return fields.map((f, i) => {
    const ask = `${f.description ?? f.label}${isNumber(f) ? ` (${answerFormatName(f.type)})` : ""}`;
    // A lone field the message already asks for needs no more words.
    const plain = fields.length === 1 && ask === f.label;
    const question = i > 0 ? ask : plain ? lead : `${lead} — ${ask}`;
    const options =
      f.type === "boolean"
        ? [{ label: "Yes" }, { label: "No" }]
        : f.choices.map((c) => ({ label: c.label }));
    return {
      id: f.id,
      header: f.label.length > 40 ? `${f.label.slice(0, 39)}…` : f.label,
      question,
      options: f.required ? options : [...options, { label: LEAVE_EMPTY }],
      multiSelect: f.type === "choices",
      allowFreeText: f.type === "text" || isNumber(f),
      ...(isNumber(f) ? { format: f.type } : {}),
    };
  });
}

/**
 * The form's content from the answers (keyed by question id), or what doesn't fit: a required
 * field without an answer, or an answer its field can't take ("five" for a number), one line
 * per field, naming it.
 */
export function formContent(
  fields: FormField[],
  answers: Record<string, string[]>,
): { content: Record<string, JsonValue> } | { problems: string[] } {
  const content: Record<string, JsonValue> = {};
  const problems: string[] = [];
  for (const f of fields) {
    const given = (answers[f.id] ?? []).map((a) => a.trim()).filter(Boolean);
    const values = f.required ? given : given.filter((a) => a !== LEAVE_EMPTY);
    if (values.length === 0) {
      if (f.required) problems.push(`${f.label}: needs an answer.`);
      continue;
    }
    const value = parse(f, values);
    if (value === undefined) problems.push(`${f.label}: ${expected(f, values)}`);
    else content[f.name] = value;
  }
  return problems.length > 0 ? { problems } : { content };
}

function parse(f: FormField, values: string[]): JsonValue | undefined {
  const [one] = values;
  switch (f.type) {
    case "text":
      return values.join("\n");
    case "number":
    case "integer":
      return values.length === 1 && one !== undefined ? parseNumberAnswer(one, f.type) : undefined;
    case "boolean":
      return values.length === 1 && one !== undefined ? parseYesNo(one) : undefined;
    case "choice":
      return values.length === 1 && one !== undefined ? choice(f, one) : undefined;
    case "choices": {
      const picked = values.map((v) => choice(f, v));
      return picked.every((v) => v !== undefined) ? (picked as string[]) : undefined;
    }
  }
}

/** Why `values` don't fit `f`, saying what it takes. */
function expected(f: FormField, values: string[]): string {
  const given = values.map((v) => `"${v.length > 60 ? `${v.slice(0, 59)}…` : v}"`).join(", ");
  switch (f.type) {
    case "number":
    case "integer":
      return `${given} isn't ${answerFormatName(f.type)}. Type ${answerFormatName(f.type)}, like ${f.type === "integer" ? "3 or 1,000" : "2.5 or 1,000"}.`;
    case "boolean":
      return `${given} isn't Yes or No.`;
    case "choice":
      return `${given} isn't one of the options. Pick one of: ${f.choices.map((c) => c.label).join(", ")}.`;
    case "choices":
      return `${given} aren't all options. Pick from: ${f.choices.map((c) => c.label).join(", ")}.`;
    case "text":
      return `${given} doesn't fit.`;
  }
}

/**
 * The value of the option the user picked. The card sends labels, so labels are matched first,
 * across every option; a raw value (a PM may answer with one) only when no label matches.
 */
const choice = (f: FormField, answer: string): string | undefined =>
  (f.choices.find((c) => c.label === answer) ?? f.choices.find((c) => c.value === answer))?.value;
