import type { FactoryLimits, FactoryTuning } from "@codeden/contracts";
import { useId, useState } from "react";
import { Field } from "@/components/automations/form-bits";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type AgentsDraft, AgentsTuning } from "./agents-tuning";
import { WIP_HELP } from "./meta";
import { type ScoutDraft, ScoutTuning } from "./scout-tuning";

/**
 * The tuning knobs the editor exposes. It saves them as a patch, so the rest (review areas, the
 * idle grace) keep their saved values.
 */
export type TuningDraft = AgentsDraft &
  ScoutDraft &
  Pick<
    FactoryTuning,
    | "requireCi"
    | "maxChangedLines"
    | "maxChangedFiles"
    | "auditCommand"
    | "maxFixAttempts"
    | "watchTimeoutMin"
    | "maxOpenPrs"
  >;

/** The editable tuning knobs of a saved tuning. */
export function tuningDraft(t: FactoryTuning): TuningDraft {
  return {
    maxOpenPrs: t.maxOpenPrs,
    requireCi: t.requireCi,
    maxChangedLines: t.maxChangedLines,
    maxChangedFiles: t.maxChangedFiles,
    auditCommand: t.auditCommand,
    maxFixAttempts: t.maxFixAttempts,
    watchTimeoutMin: t.watchTimeoutMin,
    minBacklog: t.minBacklog,
    discoveryIntervalMin: t.discoveryIntervalMin,
    discoveryPerRound: t.discoveryPerRound,
    maxIssuesPerRound: t.maxIssuesPerRound,
    builderProvider: t.builderProvider,
    builderModel: t.builderModel,
    reviewerProvider: t.reviewerProvider,
    reviewerModel: t.reviewerModel,
    reviewerFallback: t.reviewerFallback,
  };
}

/** One GitHub login per line (a leading @ is fine), as the limits store them. */
export function parseLogins(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((l) => l.trim().replace(/^@/, ""))
        .filter((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(l)),
    ),
  ];
}

const int = (s: string, min = 0): number | undefined => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= min ? n : undefined;
};

/** True when the limits carry the daily budget factory modes require. */
export function hasBudget(limits: FactoryLimits): boolean {
  return Boolean(limits.dailyBudget.usd || limits.dailyBudget.tokens);
}

/**
 * Factory settings (§10.1), enforced by the server rather than left to agents: who the factory
 * works for (trusted authors) and whether it merges by itself, a daily budget, the agent pool,
 * merges per day, the failure streak that pauses the loop, protected paths and deploys.
 * Optionally the merge-check tuning and, for a dark factory, the scout's limits.
 */
export function LimitsEditor({
  limits,
  onChange,
  tuning,
  onTuningChange,
  githubLogin,
  dark = false,
}: {
  limits: FactoryLimits;
  onChange: (l: FactoryLimits) => void;
  tuning?: TuningDraft;
  onTuningChange?: (t: TuningDraft) => void;
  /** The account CodeDen uses on GitHub (always trusted), when known. */
  githubLogin?: string | null;
  /** Show the dark factory's scout limits. */
  dark?: boolean;
}) {
  const id = useId();
  const [authors, setAuthors] = useState(() => limits.trustedAuthors.join("\n"));
  const budget = limits.dailyBudget;
  const setBudget = (patch: Partial<FactoryLimits["dailyBudget"]>) => {
    const next = { ...budget, ...patch };
    for (const k of ["usd", "tokens"] as const) if (!next[k]) delete next[k];
    onChange({ ...limits, dailyBudget: next });
  };
  return (
    <div className="space-y-4" data-testid="limits-editor">
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.autoMerge}
          aria-label="Merge automatically"
          onCheckedChange={(autoMerge) => onChange({ ...limits, autoMerge })}
          className="mt-0.5"
        />
        <span>
          Merge automatically when every check passes
          <span className="block text-3xs text-muted-foreground">
            Off (recommended to start): every pull request waits for you to review and merge it.
            Work let in from an untrusted author always waits for you.
          </span>
        </span>
      </div>
      <Field
        label="Trusted authors"
        htmlFor={`${id}-authors`}
        help={`GitHub logins, one per line. The factory only takes on issues they open${githubLogin ? `, plus @${githubLogin} (the account CodeDen uses)` : " and the account CodeDen uses"}. On a public repository anyone can open an issue: everyone else's are ignored until you let one in.`}
      >
        <Textarea
          id={`${id}-authors`}
          value={authors}
          placeholder={"octocat\nmy-teammate"}
          onChange={(e) => {
            setAuthors(e.target.value);
            onChange({ ...limits, trustedAuthors: parseLogins(e.target.value) });
          }}
          className="min-h-16 font-mono text-[12.5px]"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Daily budget (USD)"
          htmlFor={`${id}-usd`}
          help="The loop pauses until tomorrow when today's spend reaches it."
        >
          <Input
            id={`${id}-usd`}
            type="number"
            min={0}
            step="0.5"
            value={budget.usd ?? ""}
            placeholder="e.g. 10"
            onChange={(e) => {
              const n = Number.parseFloat(e.target.value);
              setBudget({ usd: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
            className="text-[13px]"
          />
        </Field>
        <Field label="Daily budget (tokens)" htmlFor={`${id}-tok`} help="Optional, alongside USD.">
          <Input
            id={`${id}-tok`}
            type="number"
            min={0}
            step={100000}
            value={budget.tokens ?? ""}
            placeholder="e.g. 5000000"
            onChange={(e) => setBudget({ tokens: int(e.target.value, 1) })}
            className="text-[13px]"
          />
        </Field>
      </div>
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.budgetScope === "project"}
          aria-label="Count all project spend against the budget"
          onCheckedChange={(all) =>
            onChange({ ...limits, budgetScope: all ? "project" : "factory" })
          }
          className="mt-0.5"
        />
        <span>
          Count all spend in this project
          <span className="block text-3xs text-muted-foreground">
            Off: only the factory's own sessions (builders, reviewers, the scout, reverts) count.
          </span>
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Agents at once"
          htmlFor={`${id}-conc`}
          help="The swarm: builders, reviewers and the scout share it."
        >
          <Input
            id={`${id}-conc`}
            type="number"
            min={1}
            value={limits.maxConcurrentSessions}
            onChange={(e) =>
              onChange({ ...limits, maxConcurrentSessions: int(e.target.value, 1) ?? 1 })
            }
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Auto-merges per day"
          htmlFor={`${id}-merges`}
          hint="With auto-merge on, the most pull requests CodeDen merges by itself in a day. Once it's reached, more work waits for tomorrow."
        >
          <Input
            id={`${id}-merges`}
            type="number"
            min={0}
            value={limits.maxMergesPerDay}
            onChange={(e) => onChange({ ...limits, maxMergesPerDay: int(e.target.value) ?? 0 })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Pause after failures"
          htmlFor={`${id}-fails`}
          hint="The factory pauses after this many failed merge checks or reverts in a row, so a broken setup doesn't keep spending. Resume it from the factory panel."
        >
          <Input
            id={`${id}-fails`}
            type="number"
            min={1}
            value={limits.pauseAfterConsecutiveFailures}
            onChange={(e) =>
              onChange({ ...limits, pauseAfterConsecutiveFailures: int(e.target.value, 1) ?? 1 })
            }
            className="text-[13px]"
          />
        </Field>
      </div>
      {tuning && onTuningChange && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="PRs open at most"
            htmlFor={`${id}-open-prs`}
            hint={WIP_HELP}
            help="Empty: the same as Agents at once."
          >
            <Input
              id={`${id}-open-prs`}
              type="number"
              min={1}
              value={tuning.maxOpenPrs ?? ""}
              placeholder={`${limits.maxConcurrentSessions} (Agents at once)`}
              onChange={(e) =>
                onTuningChange({ ...tuning, maxOpenPrs: int(e.target.value, 1) ?? null })
              }
              className="text-[13px]"
            />
          </Field>
        </div>
      )}
      <Field
        label="Protected paths"
        htmlFor={`${id}-paths`}
        help="One glob per line, on top of the vision's protected areas. Changes there always go to you."
      >
        <Textarea
          id={`${id}-paths`}
          value={limits.protectedPaths.join("\n")}
          placeholder={"**/auth/**\ninfra/**"}
          onChange={(e) =>
            onChange({
              ...limits,
              protectedPaths: e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
            })
          }
          className="min-h-20 font-mono text-[12.5px]"
        />
      </Field>
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.allowDeploys}
          aria-label="Allow deploys"
          onCheckedChange={(allowDeploys) => onChange({ ...limits, allowDeploys })}
          className="mt-0.5"
        />
        <span>
          Allow deploy and release changes
          <span className="block text-3xs text-muted-foreground">
            Off: workflows, Dockerfiles and hosting configs count as protected.
          </span>
        </span>
      </div>
      {dark && tuning && onTuningChange && (
        <ScoutTuning tuning={tuning} onChange={onTuningChange} />
      )}
      {tuning && onTuningChange && (
        <div className="space-y-3 border-t border-border pt-4" data-testid="merge-check-tuning">
          <div>
            <p className="text-[13px] font-medium">Merge checks</p>
            <p className="text-3xs text-muted-foreground">
              What a pull request must meet before it is ready to merge.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Largest change (lines)"
              htmlFor={`${id}-lines`}
              help="Lockfiles and generated files don't count. Leave empty for no limit."
            >
              <Input
                id={`${id}-lines`}
                type="number"
                min={1}
                value={tuning.maxChangedLines ?? ""}
                placeholder="No limit"
                onChange={(e) =>
                  onTuningChange({ ...tuning, maxChangedLines: int(e.target.value, 1) ?? null })
                }
                className="text-[13px]"
              />
            </Field>
            <Field
              label="Most files changed"
              htmlFor={`${id}-files`}
              help="Leave empty for no limit."
            >
              <Input
                id={`${id}-files`}
                type="number"
                min={1}
                value={tuning.maxChangedFiles ?? ""}
                placeholder="No limit"
                onChange={(e) =>
                  onTuningChange({ ...tuning, maxChangedFiles: int(e.target.value, 1) ?? null })
                }
                className="text-[13px]"
              />
            </Field>
          </div>
          <p className="text-3xs text-muted-foreground">
            Over the limit, the project manager splits the work or allows it as one change (an
            initial scaffold, say). Nothing waits on you.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Revise rounds"
              htmlFor={`${id}-fixes`}
              hint="How many times the builder may revise a pull request after the reviewer asks for changes or a merge check fails. After that the item fails, and you can run it again from its page."
            >
              <Input
                id={`${id}-fixes`}
                type="number"
                min={0}
                step={1}
                value={tuning.maxFixAttempts}
                onChange={(e) =>
                  onTuningChange({ ...tuning, maxFixAttempts: int(e.target.value) ?? 0 })
                }
                className="text-[13px]"
              />
            </Field>
            <Field
              label="Watch main CI (minutes)"
              htmlFor={`${id}-watch`}
              hint="After an automatic merge, how long the factory watches CI on the default branch. A failure while it watches reverts the merge; CI still running after this long counts as done."
            >
              <Input
                id={`${id}-watch`}
                type="number"
                min={1}
                step={1}
                value={tuning.watchTimeoutMin}
                onChange={(e) =>
                  onTuningChange({ ...tuning, watchTimeoutMin: int(e.target.value, 1) ?? 1 })
                }
                className="text-[13px]"
              />
            </Field>
          </div>
          <div className="flex items-start gap-2.5 text-xs">
            <Switch
              checked={tuning.requireCi}
              aria-label="Require CI"
              onCheckedChange={(requireCi) => onTuningChange({ ...tuning, requireCi })}
            />
            <span>
              Require CI
              <span className="block text-3xs text-muted-foreground">
                Off: a repository without CI can still merge automatically.
              </span>
            </span>
          </div>
          <Field
            label="Audit command"
            htmlFor={`${id}-audit`}
            help="Optional security or dependency scan, run in the builder's worktree."
          >
            <Input
              id={`${id}-audit`}
              value={tuning.auditCommand ?? ""}
              placeholder="pnpm audit --prod"
              onChange={(e) =>
                onTuningChange({ ...tuning, auditCommand: e.target.value.trim() || null })
              }
              className="font-mono text-[12.5px]"
            />
          </Field>
        </div>
      )}
      {tuning && onTuningChange && (
        <AgentsTuning value={tuning} onChange={(a) => onTuningChange({ ...tuning, ...a })} />
      )}
    </div>
  );
}
