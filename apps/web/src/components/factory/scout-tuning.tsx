import type { FactoryTuning } from "@codeden/contracts";
import { useId } from "react";
import { Field } from "@/components/automations/form-bits";
import { InfoHint } from "@/components/common/info-hint";
import { Input } from "@/components/ui/input";
import { REVIEW_AREAS_HELP, SCOUT_HELP } from "./meta";

/** The scout's knobs (dark factory). */
export type ScoutDraft = Pick<
  FactoryTuning,
  "minBacklog" | "discoveryIntervalMin" | "discoveryPerRound" | "maxIssuesPerRound"
>;

/** What the backlog threshold means, for its hint and the scout's description. */
export function backlogHelp(minBacklog: number): string {
  return minBacklog === 0
    ? "0: scheduled rounds are off. The scout only runs when you click Run scout now on the factory panel."
    : `The scout starts a scheduled round only when ${queueLow(minBacklog)} to be classified or for a free agent, and the interval has passed. 0 turns scheduled rounds off: then only Run scout now starts one.`;
}

/** "fewer than 3 issues wait", or "no issue waits" for a threshold of 1. */
function queueLow(minBacklog: number): string {
  return minBacklog === 1 ? "no issue waits" : `fewer than ${minBacklog} issues wait`;
}

const int = (s: string, min = 0): number | undefined => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= min ? n : undefined;
};

/** The dark factory's scout limits in the factory settings. */
export function ScoutTuning<T extends ScoutDraft>({
  tuning,
  onChange,
}: {
  tuning: T;
  onChange: (t: T) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="scout-tuning">
      <div>
        <p className="flex items-center gap-1 text-[13px] font-medium">
          The scout
          <InfoHint label="the scout">{SCOUT_HELP}</InfoHint>
        </p>
        <p className="text-3xs text-muted-foreground">
          It reviews the app against the vision{" "}
          {tuning.minBacklog === 0
            ? "when you click Run scout now"
            : `on a schedule, when ${queueLow(tuning.minBacklog)}`}
          , using a few long-lived area reviewers (one reviewer agent per review area, such as
          security or UX), and files the work worth doing.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Review when fewer than"
          htmlFor={`${id}-backlog`}
          hint={backlogHelp(tuning.minBacklog)}
          help={
            tuning.minBacklog === 0
              ? "Off: only Run scout now starts a round."
              : `issue${tuning.minBacklog === 1 ? "" : "s"} wait for an agent.`
          }
        >
          <Input
            id={`${id}-backlog`}
            type="number"
            min={0}
            step={1}
            value={tuning.minBacklog}
            onChange={(e) => onChange({ ...tuning, minBacklog: int(e.target.value) ?? 0 })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Every (hours)"
          htmlFor={`${id}-every`}
          hint={`How often the scout runs a review round: it plans what to look at, its area reviewers review, and it files issues. ${tuning.minBacklog === 0 ? "Scheduled rounds are off while the threshold is 0." : `It also waits until ${queueLow(tuning.minBacklog)}.`}`}
        >
          <Input
            id={`${id}-every`}
            type="number"
            min={1}
            value={Math.round(tuning.discoveryIntervalMin / 60)}
            onChange={(e) =>
              onChange({ ...tuning, discoveryIntervalMin: (int(e.target.value, 1) ?? 1) * 60 })
            }
            className="text-[13px]"
          />
        </Field>
        <Field label="Review areas per round" htmlFor={`${id}-areas`} hint={REVIEW_AREAS_HELP}>
          <Input
            id={`${id}-areas`}
            type="number"
            min={0}
            max={8}
            value={tuning.discoveryPerRound}
            onChange={(e) => onChange({ ...tuning, discoveryPerRound: int(e.target.value) ?? 0 })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Issues per round"
          htmlFor={`${id}-issues`}
          hint="The most issues the scout files from one round. It files only what is most worth doing, so a round can file fewer or none."
        >
          <Input
            id={`${id}-issues`}
            type="number"
            min={1}
            value={tuning.maxIssuesPerRound}
            onChange={(e) =>
              onChange({ ...tuning, maxIssuesPerRound: int(e.target.value, 1) ?? 1 })
            }
            className="text-[13px]"
          />
        </Field>
      </div>
    </div>
  );
}
