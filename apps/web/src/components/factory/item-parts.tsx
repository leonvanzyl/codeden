import { type FactoryItem, type MergeCheck, WorkType } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { SectionLabel } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CheckPill } from "./factory-columns";
import { CHECK_HELP, TYPE_LABEL } from "./meta";
import { openPrOf, RetryButton } from "./retry-button";

/**
 * Parts of the factory item page and the Factory view's item sheet (§10.1): the first step's
 * result, the item's actions, its merge checks and its session links.
 */

/** A link to the builder's or reviewer's session, or a dash when there is none. */
export function SessionLink({ id, label }: { id: string | null; label: string }) {
  if (!id)
    return <span className="text-muted-foreground">{label === "session" ? "—" : label}</span>;
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: id }}
      className="text-primary hover:underline"
    >
      {label}
    </Link>
  );
}

/** One merge check with its result. */
export function CheckRow({ check }: { check: MergeCheck }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3.5 py-2.5 last:border-0">
      <CheckPill check={check} />
      <div className="min-w-0 flex-1 text-2xs">
        <p className={cn(check.state === "fail" && "text-status-failed")}>
          {check.detail ?? CHECK_HELP[check.name]}
        </p>
        {check.escalate && (
          <p className="mt-0.5 flex items-center gap-1 text-status-waiting">
            <AlertTriangle className="size-3" /> Escalated: a human has to review and merge this
          </p>
        )}
      </div>
      <span className="shrink-0 text-3xs text-muted-foreground">{ago(check.at)}</span>
    </div>
  );
}

/** The first step's result: the bug's reproduction or the feature's analysis. */
export function InvestigationCard({ item }: { item: FactoryItem }) {
  const inv = item.investigation;
  if (!inv) return null;
  const ok = inv.outcome === "reproduced" || inv.outcome === "implement";
  return (
    <section>
      <SectionLabel className="mb-2">
        {inv.kind === "reproduction" ? "Reproduction" : "Analysis"}
      </SectionLabel>
      <div className="rounded-xl border border-border bg-card p-4 text-[13px]">
        <p className={cn("font-medium", ok ? "text-status-done" : "text-status-waiting")}>
          {inv.outcome.replace("_", " ")}
        </p>
        <p className="mt-1 leading-relaxed">{inv.summary}</p>
        {inv.testPath && (
          <p className="mt-2 text-2xs text-muted-foreground">
            Test: <code className="font-mono">{inv.testPath}</code>
          </p>
        )}
        {inv.details && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface p-2 font-sans text-2xs leading-relaxed whitespace-pre-wrap">
            {inv.details}
          </pre>
        )}
      </div>
    </section>
  );
}

/** What you can do with the item: let it in, change its pipeline, or retry it. */
export function ItemActions({ item, projectId }: { item: FactoryItem; projectId: string }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const done = (title: string) => () => {
    toast.success(title);
    void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
  };
  const fail = (title: string) => (e: Error) => toast.error(title, { description: e.message });
  const admit = useMutation({
    mutationFn: () => client.factory.admit(projectId, { itemId: item.id }),
    onSuccess: done("Let in: a person merges the result"),
    onError: fail("Couldn't let it in"),
  });
  const setType = useMutation({
    mutationFn: (type: WorkType) => client.factory.setType(projectId, { itemId: item.id, type }),
    onSuccess: done("Pipeline changed"),
    onError: fail("Couldn't change the pipeline"),
  });
  const notStarted = item.stage === "candidate" || item.stage === "backlog";
  if (item.stage === "ignored") {
    return (
      <Button
        size="sm"
        className="w-full"
        onClick={() => admit.mutate()}
        disabled={admit.isPending}
      >
        <UserCheck /> Let the factory take it on
      </Button>
    );
  }
  if (item.stage === "rejected" || item.stage === "failed") {
    const pr = openPrOf(item);
    return (
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <RetryButton
            projectId={projectId}
            itemId={item.id}
            pr={pr}
            size="sm"
            variant="outline"
            className="flex-1"
          />
          {/* With its PR open, Retry re-reviews it; starting over is the other choice. */}
          {pr && (
            <RetryButton
              projectId={projectId}
              itemId={item.id}
              pr={pr}
              mode="rebuild"
              size="sm"
              variant="ghost"
            />
          )}
        </div>
        {pr && (
          <p className="text-3xs text-muted-foreground">
            Retry sends #{pr.number} back to a fresh review; Rebuild starts over and replaces it.
          </p>
        )}
      </div>
    );
  }
  if (!notStarted) return null;
  return (
    <div className="space-y-1">
      <p className="text-3xs text-muted-foreground">Pipeline</p>
      <fieldset className="flex gap-1 border-0 p-0" aria-label="Pipeline">
        {WorkType.options.map((t) => (
          <Button
            key={t}
            size="xs"
            variant={item.type === t ? "default" : "outline"}
            disabled={setType.isPending || item.type === t}
            onClick={() => setType.mutate(t)}
          >
            {TYPE_LABEL[t]}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}
