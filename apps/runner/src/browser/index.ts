/** The runner's browser engine (§12.2): one Chromium, a context per session, CDP screencast. */
export * as browserAgent from "./agent";
export * as browserForms from "./forms";
export {
  type BrowserCommand,
  type BrowserCommandDeps,
  type BrowserCommandHandlers,
  type BrowserCommandName,
  createBrowserCommandHandlers,
  isBrowserCommand,
} from "./handlers";
export { InputForwarder, keyEventParams, mapPoint, virtualKeyCode } from "./input";
export {
  type BrowserChannel,
  findInstalledChannels,
  type LaunchedBrowser,
  type LaunchOptions,
  launchChromium,
} from "./launcher";
export { BrowserManager, type BrowserManagerOptions } from "./manager";
export { DEFAULT_SCREENCAST, Screencast, type ScreencastSettings } from "./screencast";
export { BrowserSession } from "./session";
export { devServerUrl, normalizeUrl } from "./urls";
export {
  DEFAULT_VIEWPORT,
  deviceMetricsParams,
  fitViewport,
  framePixels,
  VIEWPORT_LIMITS,
  type ViewportMetrics,
} from "./viewport";
