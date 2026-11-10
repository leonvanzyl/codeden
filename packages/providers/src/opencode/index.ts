/**
 * OpenCode adapter: a private `opencode serve --stdio` per session, driven over OpenCode's v2
 * HTTP API with its event stream (SSE). Types for the routes used are in `./protocol`.
 */
export { OPENCODE_PROVIDER_ID, OpenCodeAdapter, type OpenCodeAdapterOptions } from "./adapter";
export { OpenCodeClient, OpenCodeHttpError, SseParser } from "./client";
export {
  mcpServerConfig,
  modelRef,
  openCodeConfig,
  openCodeVariant,
  SESSION_PERMISSIONS,
  toPromptBody,
} from "./config";
export {
  authFromProbe,
  detectOpenCode,
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_LOGIN_COMMAND,
  OPENCODE_MIN_VERSION,
  OPENCODE_UPGRADE_COMMAND,
} from "./detect";
export { exeFromCmdShim, locateOpenCode, openCodeKnownLocations } from "./locate";
export { OpenCodeEventMapper } from "./mapper";
export { fallbackOpenCodeModels, modelInfoFromOpenCode, openCodeModelList } from "./models";
export { OPENCODE_UTILITY_MODEL, OpenCodeUtilityModel } from "./one-shot";
export { guardPluginSource, HIDDEN_ENV_VARS } from "./plugin";
export { OpenCodePolicy } from "./policy";
export { type OpenCodeProbe, probeOpenCode } from "./probe";
export { OpenCodeServer, openCodeServerEnv } from "./server";
export { OpenCodeSession } from "./session";
