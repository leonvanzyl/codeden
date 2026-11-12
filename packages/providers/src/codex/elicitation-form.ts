import type { UserQuestion } from "@codeden/contracts";
import type { JsonValue } from "./protocol/serde_json/JsonValue";
import type { McpElicitationPrimitiveSchema, McpElicitationSchema } from "./protocol/v2";

/**
 * An MCP server's form (the `requestedSchema` of an elicitation) as CodeDen questions, and the
 * answers back as the form's content. One question per field: choices become options, yes/no
 * fields Yes and No, text and numbers free text. Optional fields can be left empty.
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
const DECLINE = "Decline";

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

/** Labels are how answers come back, so each must name one value. */
function unique(choices: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  return choices.map((c) => {
    const label = c.label.trim() || c.value;
    const free = seen.has(label) || label === LEAVE_EMPTY ? `${label} (${c.value})` : label;
    seen.add(free);
    return { value: c.value, label: free };
  });
}

const HINTS: Partial<Record<FormField["type"], string>> = {
  integer: " (a whole number)",
  number: " (a number)",
};

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
    const ask = `${f.description ?? f.label}${HINTS[f.type] ?? ""}`;
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
      allowFreeText: f.type === "text" || f.type === "number" || f.type === "integer",
    };
  });
}

/**
 * The form's content from the answers (keyed by question id), or undefined when a required
 * field has no answer or an answer doesn't fit its field.
 */
export function formContent(
  fields: FormField[],
  answers: Record<string, string[]>,
): Record<string, JsonValue> | undefined {
  const content: Record<string, JsonValue> = {};
  for (const f of fields) {
    const given = (answers[f.id] ?? []).map((a) => a.trim()).filter(Boolean);
    const values = f.required ? given : given.filter((a) => a !== LEAVE_EMPTY);
    if (values.length === 0) {
      if (f.required) return undefined;
      continue;
    }
    const value = parse(f, values);
    if (value === undefined) return undefined;
    content[f.name] = value;
  }
  return content;
}

function parse(f: FormField, values: string[]): JsonValue | undefined {
  const [one] = values;
  switch (f.type) {
    case "text":
      return values.join("\n");
    case "number":
    case "integer": {
      const n = values.length === 1 ? Number(one) : Number.NaN;
      return Number.isFinite(n) && (f.type === "number" || Number.isInteger(n)) ? n : undefined;
    }
    case "boolean": {
      const v = values.length === 1 ? one?.toLowerCase() : undefined;
      return v === "yes" || v === "true" ? true : v === "no" || v === "false" ? false : undefined;
    }
    case "choice":
      return values.length === 1 && one !== undefined ? choice(f, one) : undefined;
    case "choices": {
      const picked = values.map((v) => choice(f, v));
      return picked.every((v) => v !== undefined) ? (picked as string[]) : undefined;
    }
  }
}

const choice = (f: FormField, answer: string): string | undefined =>
  f.choices.find((c) => c.label === answer || c.value === answer)?.value;
