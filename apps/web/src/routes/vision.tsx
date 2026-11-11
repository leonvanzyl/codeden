import { type ParsedVision, parseVision } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, FileWarning, ShieldAlert, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SectionLabel } from "@/components/common/bits";
import { CodeEditor } from "@/components/editor/code-editor";
import { SaveDiffDialog } from "@/components/editor/save-diff-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { factoryKeys, useVision } from "@/lib/factory";
import { useProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

const SECTIONS: { key: keyof Omit<ParsedVision, "protectedAreas">; label: string }[] = [
  { key: "goals", label: "Goals" },
  { key: "users", label: "Target users" },
  { key: "principles", label: "Principles" },
  { key: "outOfScope", label: "Out of scope" },
  { key: "qualityBar", label: "Quality bar" },
];

/** What the server will read from the draft: sections and the protected areas. */
function VisionPreview({ parsed, extraPaths }: { parsed: ParsedVision; extraPaths: string[] }) {
  const { globs, topics } = parsed.protectedAreas;
  return (
    <div className="space-y-5" data-testid="vision-preview">
      <div>
        <SectionLabel className="mb-2">Sections</SectionLabel>
        <div className="space-y-1 text-[13px]">
          {SECTIONS.map((s) => {
            const n = parsed[s.key].length;
            return (
              <div key={s.key} className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    n ? "bg-status-done" : "bg-status-waiting",
                  )}
                />
                <span className={n ? "" : "text-muted-foreground"}>{s.label}</span>
                <span className="ml-auto text-3xs text-muted-foreground tabular-nums">
                  {n || "empty"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <SectionLabel className="mb-2 flex items-center gap-1.5">
          <ShieldAlert className="size-3.5" /> Protected areas
        </SectionLabel>
        <p className="mb-2 text-2xs text-muted-foreground">
          Changes that touch these are never merged by the factory; they come to your inbox.
        </p>
        <div className="flex flex-wrap gap-1" data-testid="protected-globs">
          {globs.map((g) => (
            <code key={g} className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs">
              {g}
            </code>
          ))}
          {globs.length === 0 && <span className="text-2xs text-status-waiting">No paths</span>}
        </div>
        {topics.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" data-testid="protected-topics">
            {topics.map((t) => (
              <span
                key={t}
                className="rounded-full border border-status-waiting/30 bg-status-waiting/8 px-2 py-0.5 text-3xs text-status-waiting"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {topics.length > 0 && (
          <p className="mt-1.5 text-3xs text-muted-foreground">
            Topics are also searched for in PR titles and descriptions.
          </p>
        )}
        {extraPaths.length > 0 && (
          <p className="mt-2 text-3xs text-muted-foreground">
            Plus from the limits: <span className="font-mono">{extraPaths.join(", ")}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Vision editor (§10.1): required for the software and dark factory; agents work to it. */
export function VisionPage({ projectId }: { projectId: string }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const project = useProject(projectId);
  const { data } = useVision(projectId);
  const [draft, setDraft] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  // CodeMirror keeps LF line endings; compare and edit the file in that form.
  const saved = data?.contents.replace(/\r\n/g, "\n");
  useEffect(() => setDraft(saved ?? null), [saved]);
  const parsed = useMemo(() => parseVision(draft ?? ""), [draft]);
  const save = useMutation({
    mutationFn: () => client.factory.saveVision(projectId, draft ?? ""),
    onSuccess: (res) => {
      setReview(false);
      queryClient.setQueryData(factoryKeys.vision(projectId), res);
      void queryClient.invalidateQueries({ queryKey: ["factory", "status", projectId] });
      toast.success("Vision saved", { description: res.path });
    },
    onError: (e) => toast.error("Couldn't save the vision", { description: e.message }),
  });
  const exists = data?.exists ?? false;
  const dirty = draft !== null && (draft !== saved || !exists);

  return (
    <>
      <PageHeader
        icon={<Target />}
        title={`${project?.name ?? "Project"} vision`}
        meta={<code className="font-mono">{data?.path ?? project?.visionPath}</code>}
        actions={
          <>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/projects/$projectId" params={{ projectId }}>
                <ChevronLeft /> Project
              </Link>
            </Button>
            <Button size="sm" disabled={!dirty} onClick={() => setReview(true)}>
              {exists ? "Review & save" : "Create vision file"}
            </Button>
          </>
        }
      />
      {data && !exists && (
        <div className="flex items-center gap-2 border-b border-status-waiting/25 bg-status-waiting/[0.06] px-5 py-2 text-2xs">
          <FileWarning className="size-3.5 text-status-waiting" />
          No vision file yet. This is the template; edit it and save to create {data.path}.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-border" data-testid="vision-editor">
          {draft === null ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <CodeEditor
              docKey={`vision-${projectId}-${exists}`}
              value={draft}
              onChange={setDraft}
              onSave={() => dirty && setReview(true)}
            />
          )}
        </div>
        <aside className="hidden w-80 shrink-0 overflow-y-auto p-5 scroll-thin lg:block">
          <p className="mb-5 text-[13px] text-muted-foreground">
            The PM scores every candidate against this file and the reviewer checks changes against
            it. Keep it short and concrete.
          </p>
          <VisionPreview parsed={parsed} extraPaths={project?.factoryLimits.protectedPaths ?? []} />
        </aside>
      </div>
      <SaveDiffDialog
        open={review}
        onOpenChange={setReview}
        path={data?.path ?? "VISION.md"}
        before={exists ? (data?.contents ?? "") : ""}
        after={draft ?? ""}
        onConfirm={() => save.mutate()}
        saving={save.isPending}
      />
    </>
  );
}
