import { CODEDEN_VERSION, DesktopHostMessage, type DesktopServerMessage } from "@codeden/contracts";
import { applyLoginShellPath } from "@codeden/providers";
import { ensureHome, ensureInstallToken, resolveHome, startServer } from "@codeden/server";
import { serverLog } from "./log";
import { IpcDesktopUpdater } from "./update-bridge";

/** How long a server whose app went away gets to close before it exits anyway. */
const ORPHAN_CLOSE_MS = 30_000;

/**
 * Start the server for the desktop app and connect it to the main process: report `ready`,
 * mirror the updater, and close on `shutdown` (with the runner when asked, as `codeden stop`
 * does) or when the main process goes away (the runner keeps running).
 */
export async function serve(opts: { home?: string; port: number; fake: boolean }): Promise<void> {
  const send = (message: DesktopServerMessage) => process.send?.(message);
  const home = resolveHome(opts.home);
  const paths = ensureHome(home);
  const token = ensureInstallToken(paths.token);
  const desktop = new IpcDesktopUpdater(send, CODEDEN_VERSION);
  let closing = false;
  // An app started from the Dock, the Finder or a desktop launcher has the system's minimal
  // PATH: the checks, the runner and agents look for tools on the user's login-shell PATH.
  await applyLoginShellPath();

  const server = await startServer({
    port: opts.port,
    dataDir: home,
    token,
    enableFakeProvider: opts.fake || process.env.CODEDEN_FAKE_PROVIDER === "1",
    onShutdownRequest: () => process.exit(0),
    selfUpdate: {
      source: "desktop",
      restartCommand: "Quit CodeDen from the tray and open it again",
      launcherVersion: CODEDEN_VERSION,
      desktop,
    },
    log: serverLog(),
  });

  const close = (stopRunner: boolean) => {
    if (closing) return;
    closing = true;
    // Commands still waiting (an install in progress) end with this process, not with an error.
    void server
      .close({ stopRunner })
      .catch((error: unknown) => console.error(error))
      .finally(() => process.exit(0));
  };
  process.on("message", (raw) => {
    const parsed = DesktopHostMessage.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.type === "shutdown") close(parsed.data.stopRunner);
    else desktop.handle(parsed.data);
  });
  // The app quit or crashed without asking: close; the runner keeps the agents going. Nobody
  // is left to stop this process if closing hangs, so it exits on its own after a while.
  process.on("disconnect", () => {
    close(false);
    setTimeout(() => process.exit(0), ORPHAN_CLOSE_MS).unref();
  });
  // A signal while already closing means the app gave up waiting: exit now.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => (closing ? process.exit(0) : close(false)));
  }

  console.log(`CodeDen ${CODEDEN_VERSION} is running at ${server.url}`);
  // Network access (§15.1) works the same as with \`codeden\`: the server moves only its HTTP
  // listener when it is switched, so the app and the runner carry on.
  if (server.network.enabled) {
    for (const address of server.network.addresses()) {
      console.log(`  ${address.label}: ${address.url}`);
    }
  }
  send({
    type: "ready",
    url: server.url,
    port: server.port,
    launchUrl: server.launchUrl,
    version: CODEDEN_VERSION,
  });
}
