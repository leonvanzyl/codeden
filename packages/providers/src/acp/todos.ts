import type { ItemOf } from "@codeden/contracts";
import type { AcpPlanEntry } from "./protocol";

export type Todo = ItemOf<"todo_list">["todos"][number];

/** An agent plan's entries as todos (unknown statuses count as pending). */
export function planTodos(entries: readonly AcpPlanEntry[]): Todo[] {
  return entries
    .filter((e) => typeof e?.content === "string" && e.content.trim())
    .map((e, i) => ({ id: String(i + 1), text: e.content, status: todoStatus(e.status) }));
}

export function todoStatus(status: unknown): Todo["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

/** Update `current` by id with `next`; new ids are appended. */
export function mergeTodos(current: readonly Todo[], next: readonly Todo[]): Todo[] {
  const out = [...current];
  for (const todo of next) {
    const at = todo.id ? out.findIndex((t) => t.id === todo.id) : -1;
    if (at >= 0) out[at] = todo;
    else out.push(todo);
  }
  return out;
}
