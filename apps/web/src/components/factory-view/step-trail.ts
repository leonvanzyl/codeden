import type { FactoryItemStage, PipelineStep, WorkType } from "@codeden/contracts";

/** The steps of each pipeline, in order (§10.1). */
const PIPELINE_STEPS: Record<WorkType, PipelineStep[]> = {
  bug: ["intake", "reproduce", "implement", "review", "merge"],
  feature: ["intake", "analyze", "implement", "review", "merge"],
  docs: ["intake", "implement", "review", "merge"],
};

export type StepMark = "done" | "current" | "next";

export interface TrailStep {
  step: PipelineStep;
  mark: StepMark;
  /** What the current step waits on, when it isn't plain work on it. */
  note: string | null;
}

/**
 * Each step of the item's pipeline marked done, current or still to come, from the step the
 * status reports (the one the board draws it on):
 * - a queued item is classified and waits for a free agent on its first step;
 * - right after an automatic merge (`watching`) Merge stays current while CI on the default
 *   branch is watched; only a merged item has every step done;
 * - a stopped item (failed, rejected) has no current step.
 */
export function stepTrail(item: {
  type: WorkType | null;
  step: PipelineStep;
  stage: FactoryItemStage;
}): TrailStep[] {
  const steps = PIPELINE_STEPS[item.type ?? "feature"];
  let at: number;
  let note: string | null = null;
  if (item.stage === "merged" || item.step === "done") at = steps.length;
  else if (item.stage === "watching") {
    at = steps.indexOf("merge");
    note = "Merged; watching CI on the default branch";
  } else if (item.step === "queued") {
    at = 1;
    note = "Waiting for a free agent";
  } else if (item.step === "stopped" || item.step === "ignored") at = -1;
  else at = steps.indexOf(item.step);
  return steps.map((step, i) => {
    const mark: StepMark = at === -1 ? "next" : i < at ? "done" : i === at ? "current" : "next";
    return { step, mark, note: mark === "current" ? note : null };
  });
}
