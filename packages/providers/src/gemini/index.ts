/**
 * Gemini CLI adapter: its ACP server (`gemini --acp`) driven by the generic ACP client, plus
 * discovery, a login readout from its own settings, its model aliases and its vendor fields.
 */
export {
  GEMINI_AGENT,
  GEMINI_PROVIDER_ID,
  GeminiAdapter,
  type GeminiAdapterOptions,
} from "./adapter";
export {
  type GeminiAuth,
  type GeminiAuthInputs,
  geminiDir,
  parseGeminiAuth,
  readGeminiAuth,
} from "./auth";
export {
  detectGemini,
  GEMINI_INSTALL_COMMAND,
  GEMINI_LOGIN_COMMAND,
  GEMINI_MIN_VERSION,
  GEMINI_UPGRADE_COMMAND,
  isSupportedGeminiVersion,
} from "./detect";
export { geminiExtensions, geminiToolFacts, readPlan } from "./extensions";
export { fallbackGeminiModels, geminiModelInfos } from "./models";
export { GEMINI_ACP_ARGS, type GeminiProbe, probeGemini } from "./probe";
