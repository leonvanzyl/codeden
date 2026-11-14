import { drainText, type FactoryStatus } from "@codeden/contracts";
import { Hourglass } from "lucide-react";
import { InfoHint } from "@/components/common/info-hint";

/**
 * The kill switch's drain on the factory panel and the Factory view (`FactoryStatus.drain`):
 * "Draining: 2 items in flight". Nothing new starts, and the loop stops once they finish.
 */
export function DrainChip({ f }: { f: FactoryStatus }) {
  if (!f.drain) return null;
  const paused = f.loopState === "paused";
  const deadline = f.drain.deadline
    ? ` If work is still in flight at ${new Date(f.drain.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, everything stops at once.`
    : "";
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-status-waiting/12 px-2 py-0.5 text-2xs font-medium text-status-waiting"
      data-testid="factory-drain"
    >
      <Hourglass className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{drainText(f.drain.inFlight)}</span>
      {paused && <span className="truncate font-normal">· paused: {f.pausedReason}</span>}
      <InfoHint label="draining">
        {`Finishing current work, then stopping: no new issues, builds or scout rounds start, while the work in flight carries on until it merges, fails or needs you. Then the factory stops by itself. Resume cancels it; Stop now stops everything at once.${deadline}`}
      </InfoHint>
    </span>
  );
}
