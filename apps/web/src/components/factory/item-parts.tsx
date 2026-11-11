import { type FactoryItem, WorkType } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { SectionLabel } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { cn } from "@/lib/utils";
import { TYPE_LABEL } from "./meta";

/** Parts of the factory item page (§10.1): the first step's result and the item's actions. */

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
  const retry = useMutation({
    mutationFn: () => client.factory.retry(projectId, item.id),
    onSuccess: done("Queued again"),
    onError: fail("Couldn't retry"),
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
    return (
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => retry.mutate()}
        disabled={retry.isPending}
      >
        <RotateCcw /> Retry
      </Button>
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
