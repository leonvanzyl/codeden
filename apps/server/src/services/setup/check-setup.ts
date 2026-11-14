import type { SetupStatus } from "@codeden/contracts";
import { homePaths } from "../../paths";
import { SettingsStore } from "../../settings-store";
import { type Exec, runTool } from "../exec";
import { SetupService } from "./setup-service";

/**
 * Run the first-run detection checks (§14) outside a server, e.g. for `codeden doctor`.
 * Reads the home's settings when they exist and never writes anything: a broken settings file
 * is left for the server, which keeps a copy and tells the user.
 */
export async function checkSetup(opts: { home: string; exec?: Exec }): Promise<SetupStatus> {
  const current = SettingsStore.read(homePaths(opts.home).settings);
  const settings = { get: () => current, update: () => current };
  return new SetupService({ exec: opts.exec ?? runTool, settings }).status({ refresh: true });
}
