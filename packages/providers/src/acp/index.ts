/**
 * Generic Agent Client Protocol (ACP) client: drives any agent that serves ACP version 1 on
 * stdio. Vendor layers (Cursor, Gemini CLI) add discovery, models and their extensions on top.
 */
export { answerPermission, approvalItem, select } from "./approvals";
export { acpMcpServers, findOption, modeIds, modelsOf, optionId, optionValues } from "./config";
export { classifyAcpError, failedPrompt, stopOutcome } from "./errors";
export type {
  AcpAgentSpec,
  AcpExtensionHost,
  AcpExtensions,
  AcpSessionConfig,
} from "./extensions";
export {
  type AcpToolFacts,
  type AcpToolState,
  mcpOf,
  mergeToolCall,
  promptBlocks,
  toolCallItem,
} from "./items";
export { AcpEventMapper, planTodos, todoStatus } from "./mapper";
export { AcpPolicy } from "./policy";
export { clientCapabilities, startAgent } from "./process";
export * from "./protocol";
export { AcpRpc, AcpRpcError, METHOD_NOT_FOUND } from "./rpc";
export { AcpSession } from "./session";
export { AcpSubagents, type AcpTaskReport, agentTypeOf } from "./subagents";
