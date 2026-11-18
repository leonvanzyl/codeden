/**
 * Development entry (`pnpm dev`): data in `<repo>/.codeden-dev`, fixed port 4318, the Fake
 * provider enabled, and the Vite dev server allowed as an origin.
 */
import { resolve } from "node:path";
import { applyLoginShellPath } from "@codeden/providers";
import { ensureHome } from "./paths";
import { startServer } from "./server";
import { ensureInstallToken } from "./token";

const home = process.env.CODEDEN_HOME ?? resolve(import.meta.dirname, "../../../.codeden-dev");
const port = Number(process.env.CODEDEN_PORT ?? 4318);
const token = ensureInstallToken(ensureHome(home).token);
// As the CLI and the desktop app do, so a re-check also picks up tools installed meanwhile.
await applyLoginShellPath();

const server = await startServer({
  port,
  dataDir: home,
  token,
  enableFakeProvider: true,
  allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  log: (m) => console.log(`[codeden] ${m}`),
});
console.log(`[codeden] UI (vite): http://localhost:5173   API: ${server.url}`);

const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
