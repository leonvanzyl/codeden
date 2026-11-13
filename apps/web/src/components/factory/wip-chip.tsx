import type { FactoryStatus } from "@codeden/contracts";
import { Hourglass } from "lucide-react";
import { InfoHint } from "@/components/common/info-hint";
import { cn } from "@/lib/utils";
import { WIP_HELP, wipLabel } from "./meta";

/**
 * "Finishing open work (2 of 2 PRs open)": shown while the work-in-progress limit holds new
 * work back (`FactoryStatus.wip`), on the factory panel and the Factory view.
 */
export function WipChip({ f, className }: { f: FactoryStatus; className?: string }) {
  if (!f.wip.holding) return null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-status-waiting/12 px-2 py-0.5 text-2xs font-medium text-status-waiting",
        className,
      )}
      data-testid="factory-wip"
    >
      <Hourglass className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{wipLabel(f.wip)}</span>
      <InfoHint label="finishing open work">
        {`New builds and the scout wait until a pull request merges or closes. ${WIP_HELP}`}
      </InfoHint>
    </span>
  );
}
