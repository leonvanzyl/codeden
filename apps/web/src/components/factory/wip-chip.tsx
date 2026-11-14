import type { FactoryStatus } from "@codeden/contracts";
import { Hourglass, Unplug } from "lucide-react";
import { InfoHint } from "@/components/common/info-hint";
import { cn } from "@/lib/utils";
import { PROVIDER_WAIT_HELP, WIP_HELP, wipLabel } from "./meta";

const CHIP =
  "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-status-waiting/12 px-2 py-0.5 text-2xs font-medium text-status-waiting";

/**
 * The work-in-progress limit on the factory panel and the Factory view (`FactoryStatus.wip`):
 * "Finishing open work (2 of 2 PRs open)" while it holds new work back, and which PRs wait on a
 * provider that is signed out or at its usage limit ("1 PR waits on Codex (not signed in) and
 * doesn't count").
 */
export function WipChip({ f, className }: { f: FactoryStatus; className?: string }) {
  const { holding, note } = f.wip;
  if (!holding && !note) return null;
  return (
    <>
      {holding && (
        <span className={cn(CHIP, className)} data-testid="factory-wip">
          <Hourglass className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{wipLabel(f.wip)}</span>
          <InfoHint label="finishing open work">
            {`New builds and the scout wait until a pull request merges or closes. ${WIP_HELP}`}
          </InfoHint>
        </span>
      )}
      {note && (
        <span className={cn(CHIP, className)} data-testid="factory-wip-provider" title={note}>
          <Unplug className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{note}</span>
          <InfoHint label="waiting on a provider">{PROVIDER_WAIT_HELP}</InfoHint>
        </span>
      )}
    </>
  );
}
