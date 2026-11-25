import type { RunnerConnectionStatus } from "@codeden/contracts";

export type RunnerStatusTone = "done" | "waiting" | "failed";

/**
 * The sidebar's one-line connection status and its tooltip. While the server waits for a
 * runner it is starting, the line says so; a runner that crashed during start-up shows why in
 * the tooltip (the server puts the end of `logs/runner.log` in `lastError`).
 */
export function runnerStatusText(
  socket: string,
  runner: RunnerConnectionStatus | null,
): { tone: RunnerStatusTone; label: string; detail: string } {
  if (socket !== "open") return { tone: "failed", label: "Connecting…", detail: "Connecting…" };
  if (!runner) return { tone: "waiting", label: "Runner unknown", detail: "Runner unknown" };
  const providers = runner.providers.map((p) => p.displayName).join(", ");
  const note = runner.lastError ? `\n${runner.lastError}` : "";
  switch (runner.state) {
    case "connected":
      if (runner.responsive === false) {
        return {
          tone: "failed",
          label: "Runner unresponsive",
          detail: `The runner is connected and hasn't answered the server recently.${note}`,
        };
      }
      return { tone: "done", label: "Ready", detail: `Runner connected · ${providers}${note}` };
    case "starting":
      return {
        tone: "waiting",
        label: "Starting the runner…",
        detail: `Starting the runner…${note}`,
      };
    default:
      return {
        tone: runner.lastError ? "failed" : "waiting",
        label: `Runner ${runner.state}`,
        detail: `Runner ${runner.state}${note}`,
      };
  }
}
