/**
 * Cursor adapter: the Cursor CLI's ACP server (`agent acp`) driven by the generic ACP client,
 * plus Cursor's discovery, login check, model list and extension methods.
 */
export {
  CURSOR_AGENT,
  CURSOR_PROVIDER_ID,
  CursorAdapter,
  type CursorAdapterOptions,
} from "./adapter";
export { cursorInstallCommand, detectCursor, findCursor, parseCursorStatus } from "./detect";
export { cursorExtensions, cursorTodos, planMarkdown, questionAnswer } from "./extensions";
export { CURSOR_COMMANDS, isCursorVersion, locateCursor } from "./locate";
export {
  cursorModelInfos,
  fallbackCursorModels,
  modelsFromListing,
  parseModelList,
} from "./models";
export { type CursorProbe, LIST_MODELS, probeCursor } from "./probe";
