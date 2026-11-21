import { writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in for the desktop server (`dist/server.js`) whose close never finishes: it reports
// ready, then ignores the app's `shutdown` request. With STUCK_SERVER_MODE=ignore-term it also
// ignores SIGTERM, so only SIGKILL ends it.
const recordPath = process.env.STUCK_SERVER_MODE === "record-path";
if (recordPath) {
  const home = process.argv[process.argv.indexOf("--home") + 1];
  writeFileSync(join(home, "server-path"), process.env.PATH ?? "");
}
process.send({
  type: "ready",
  url: "http://127.0.0.1:1",
  port: 1,
  launchUrl: "http://127.0.0.1:1/",
  version: "0.0.0",
});
process.on("message", (message) => {
  if (recordPath && message.type === "shutdown") process.exit(0);
});
if (process.env.STUCK_SERVER_MODE === "ignore-term") process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
