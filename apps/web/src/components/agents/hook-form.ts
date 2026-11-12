import {
  HOOK_TYPE_MAIN_FIELD,
  type HookEntry,
  HookEventName,
  type HookHandler,
} from "@codeden/contracts";

/** Hook types the dialog edits; others are listed and can be disabled or deleted. */
export type EditableHookType = keyof typeof HOOK_TYPE_MAIN_FIELD;

export const HOOK_TYPE_LABELS: Record<EditableHookType, { label: string; field: string }> = {
  command: { label: "Command", field: "Command" },
  http: { label: "HTTP", field: "URL" },
  prompt: { label: "Prompt", field: "Prompt" },
  agent: { label: "Agent", field: "Prompt" },
};

export const isEditableHook = (h: HookHandler): h is HookHandler & { type: EditableHookType } =>
  Object.hasOwn(HOOK_TYPE_MAIN_FIELD, h.type);

/** The hook form as plain strings. */
export interface HookForm {
  event: string;
  matcher: string;
  type: EditableHookType;
  /** The command, URL or prompt (by type). */
  value: string;
  /** Seconds, empty for the provider's default. */
  timeout: string;
}

export const emptyHookForm: HookForm = {
  event: "PreToolUse",
  matcher: "",
  type: "command",
  value: "",
  timeout: "",
};

export function entryToForm(e: HookEntry): HookForm {
  const type = isEditableHook(e.handler) ? e.handler.type : "command";
  return {
    event: e.event,
    matcher: e.matcher ?? "",
    type,
    value: e.handler[HOOK_TYPE_MAIN_FIELD[type]] ?? "",
    timeout: e.handler.timeout === undefined ? "" : String(e.handler.timeout),
  };
}

/**
 * Fields that belong to one hook type (from Claude Code's hooks reference). When a hook changes
 * type, only these are dropped, and only if the new type doesn't have them too.
 */
const TYPE_FIELDS: Record<EditableHookType, string[]> = {
  command: ["command", "args", "async", "asyncRewake", "shell"],
  http: ["url", "headers", "allowedEnvVars"],
  prompt: ["prompt", "model"],
  agent: ["prompt", "model"],
};

/**
 * The form as a native handler. Editing starts from the previous handler so every field the
 * dialog doesn't show (`if`, `statusMessage`, `model`, `headers`, future fields, …) and their
 * order survive. When the type changes, only the old type's own fields that the new type
 * doesn't have are dropped (e.g. `command` and `async` going from command to prompt).
 */
export function formToHandler(form: HookForm, previous?: HookHandler): HookHandler {
  const main = HOOK_TYPE_MAIN_FIELD[form.type];
  const oldType = previous && isEditableHook(previous) ? previous.type : undefined;
  const incompatible = oldType
    ? TYPE_FIELDS[oldType].filter((f) => !TYPE_FIELDS[form.type].includes(f))
    : [];
  // `type` and the main field first for a new handler; existing keys keep their places.
  const base: Record<string, unknown> = { type: form.type, [main]: "" };
  for (const [k, v] of Object.entries(previous ?? {})) {
    if (!incompatible.includes(k)) base[k] = v;
  }
  base.type = form.type;
  base[main] = form.value.trim();
  const timeout = Number(form.timeout);
  if (form.timeout.trim() && timeout > 0) base.timeout = timeout;
  else delete base.timeout;
  return base as HookHandler;
}

export function hookFormValid(form: HookForm): boolean {
  const timeout = form.timeout.trim();
  return (
    HookEventName.safeParse(form.event).success &&
    form.value.trim() !== "" &&
    (timeout === "" || Number(timeout) > 0)
  );
}

/** One-line summary of what a hook runs. */
export function hookSummary(h: HookHandler): string {
  const main = h.command ?? h.url ?? h.prompt;
  if (main) return main;
  if (typeof h.server === "string" && typeof h.tool === "string") return `${h.server} · ${h.tool}`;
  const { type: _type, timeout: _timeout, ...rest } = h;
  return JSON.stringify(rest);
}
