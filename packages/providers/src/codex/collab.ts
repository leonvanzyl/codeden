import type { ItemStatus, ToolCallItem } from "@codeden/contracts";
import { toJson, toolOutput } from "../util/text";
import type { CollabAgentStatus, CollabAgentTool, ThreadItem } from "./protocol/v2";

/** A Codex call from one agent to others (spawn, message, wait, close, …). */
export type CollabItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

/** Display name of a sub-agent by its Codex thread id, when CodeDen knows it. */
export type AgentNames = (codexThreadId: string) => string | undefined;

/** Title for one target, and the verb for several (`Wait for` 3 agents). */
const ACTIONS: Record<CollabAgentTool, [one: string, many: string]> = {
  spawnAgent: ["Start agent", "Start"],
  sendInput: ["Message agent", "Message"],
  sendMessage: ["Message agent", "Message"],
  followupTask: ["Follow up with agent", "Follow up with"],
  resumeAgent: ["Resume agent", "Resume"],
  wait: ["Wait for agent", "Wait for"],
  closeAgent: ["Close agent", "Close"],
  interruptAgent: ["Interrupt agent", "Interrupt"],
  listAgents: ["List agents", "List"],
};

const STATUS_LABELS: Record<CollabAgentStatus, string> = {
  pendingInit: "starting",
  running: "running",
  interrupted: "interrupted",
  completed: "completed",
  errored: "failed",
  shutdown: "closed",
  notFound: "not found",
};

/** Agent statuses after which a sub-agent is no longer working. */
export const FINAL_AGENT_STATUSES: ReadonlySet<CollabAgentStatus> = new Set([
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

/** `Wait for agent: explorer`, `Message 2 agents`, `List agents`. */
export function collabTitle(item: CollabItem, names: AgentNames): string {
  const [one, many] = ACTIONS[item.tool];
  if (item.tool === "listAgents") return one;
  const ids = item.receiverThreadIds;
  if (ids.length > 1) return `${many} ${ids.length} agents`;
  const name = ids[0] ? names(ids[0]) : undefined;
  return name ? `${one}: ${name}` : one;
}

/** One line per agent the call reports on: `explorer (completed): Found 3 call sites`. */
function statesText(item: CollabItem, names: AgentNames): string {
  const lines: string[] = [];
  for (const [id, state] of Object.entries(item.agentsStates)) {
    if (!state) continue;
    const head = `${names(id) ?? "agent"} (${STATUS_LABELS[state.status] ?? state.status})`;
    lines.push(state.message ? `${head}: ${state.message}` : head);
  }
  return lines.join("\n");
}

/**
 * A collab call other than a spawn, as a tool call titled after the agents it targets. Spawns
 * become `subagent` items instead (see `CodexSubagents`).
 */
export function collabToolCall(
  item: CollabItem,
  status: ItemStatus,
  names: AgentNames,
): ToolCallItem {
  const text = statesText(item, names);
  return {
    id: item.id,
    kind: "tool_call",
    toolKind: "other",
    status,
    toolName: `agent.${item.tool}`,
    title: collabTitle(item, names),
    input: toJson({
      ...(item.prompt ? { prompt: item.prompt } : {}),
      receiverThreadIds: item.receiverThreadIds,
      ...(item.model ? { model: item.model } : {}),
    }),
    ...(text ? { output: toolOutput(text) } : {}),
  };
}
