/** @codeden/providers: provider adapters behind the normalized `ProviderAdapter` interface (§7.1). */
export * from "./adapter";
export { ApprovalBroker, type ItemCtx } from "./approvals";
export * from "./async-queue";
export * from "./claude";
export * from "./codex";
export { FakeProvider, type FakeProviderOptions } from "./fake/adapter";
export { FakeSession } from "./fake/session";
export * from "./image";
export { ModelCatalog } from "./models";
export * from "./opencode";
export { isInWorkspace, isSecretPath, type PathContext } from "./policy/paths";
export {
  classifyCommand,
  classifyFetch,
  classifyRead,
  classifyWrite,
  type RiskAssessment,
  type RiskContext,
} from "./policy/risk";
export * from "./registry";
export * from "./replay";
export { brokenInstallMessage } from "./util/detect-exe";
export {
  isElectronRuntime,
  ownNodeEnv,
  type ResolvedCommand,
  resolveExecutable,
  scriptRuntime,
} from "./util/exec";
export { acquireInstallLock, type InstallLockOptions } from "./util/install-lock";
export { type KnownLocationOptions, knownLocations } from "./util/known-locations";
export {
  clearExecutableCache,
  type ExecutableLookup,
  findExecutable,
  type LocateOptions,
  quickLocate,
  runsVersion,
  type Validation,
} from "./util/locate";
export { resolveNpm } from "./util/npm";
export { npmFailure, type RunNpmOptions, runNpm } from "./util/npm-run";
export {
  defaultShell,
  quoteForShell,
  type ShellSyntax,
  shellCommandLine,
  shellSyntax,
} from "./util/shell-command";
export { inspectFile, shimTarget } from "./util/shim";
export {
  expandWindowsVars,
  parseRegQuery,
  type RefreshPathOptions,
  type RegistryPathReader,
  refreshProcessPath,
} from "./util/system-path";
export type { OneShotRequest, UtilityModel } from "./utility";
