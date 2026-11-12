import type { AutonomyLevel } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Play, Save, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AutomationForm } from "@/components/automations/automation-form";
import {
  type AutomationDraft,
  blankDraft,
  draftFromSession,
  draftFromTemplate,
  draftProblems,
  toCreateRequest,
} from "@/components/automations/draft";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { automationKeys, runResultText, useAutomationTemplates } from "@/lib/automations";
import { localTimezone } from "@/lib/cron";
import { useProject, useSnapshotData } from "@/lib/queries";
import { PageHeader } from "./page-header";

/**
 * New automation (§10): one editor for name, target, schedule, prompt, agent and permissions,
 * blank or prefilled from a template or from a session ("Make an automation…"). Saved off unless
 * switched on here; "Save and run now" also starts a run in this project.
 */
export function NewAutomationPage({
  projectId,
  templateId,
  sessionId,
}: {
  projectId: string;
  templateId?: string;
  /** Prefill from this session: its opening message, agent and permissions. */
  sessionId?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const defaultAutonomy = useSnapshotData<AutonomyLevel>(
    (s) => s.settings.autonomy.default,
    "auto",
  );
  const templates = useAutomationTemplates();
  const template = templateId ? templates.data?.find((t) => t.id === templateId) : undefined;
  // Read once, fresh: the draft is built from the transcript as it is now.
  const source = useQuery({
    queryKey: ["automation-from-session", sessionId],
    queryFn: () => client.getSessionSnapshot(sessionId ?? ""),
    enabled: Boolean(sessionId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const fromSession = source.data?.session;
  const [draft, setDraft] = useState<AutomationDraft | null>(
    templateId || sessionId ? null : blankDraft(defaultAutonomy),
  );
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (draft) return;
    if (sessionId) {
      if (source.data) setDraft(draftFromSession(source.data.session, source.data.items));
      else if (source.error) {
        toast.error("Couldn't read that session", { description: source.error.message });
        setDraft(blankDraft(defaultAutonomy));
      }
      return;
    }
    if (templateId && template) setDraft(draftFromTemplate(template, defaultAutonomy));
    else if (templateId && templates.isSuccess) setDraft(blankDraft(defaultAutonomy));
  }, [
    sessionId,
    source.data,
    source.error,
    templateId,
    template,
    templates.isSuccess,
    draft,
    defaultAutonomy,
  ]);

  const create = useMutation({
    mutationFn: async (v: { draft: AutomationDraft; run: boolean }) => {
      const item = await client.automations.create(toCreateRequest(v.draft, projectId, enabled));
      const run = v.run
        ? await client.automations.run(item.automation.id, { projectId }).catch((e: Error) => e)
        : null;
      return { item, run };
    },
    onSuccess: ({ item, run }) => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
      toast.success(
        `${item.automation.name} saved${item.automation.enabled ? " and on" : ", off"}`,
      );
      if (run instanceof Error) toast.error("Couldn't run it", { description: run.message });
      else if (run?.status === "conflict") {
        toast.warning("Not run: matching work is already running", {
          description: "Use Run now on the automation to wait, join or run anyway.",
        });
      } else if (run) toast.success(runResultText(run));
      void navigate({
        to: "/projects/$projectId/automations/$automationId",
        params: { projectId, automationId: item.automation.id },
        replace: true,
      });
    },
    onError: (e) => toast.error("Couldn't save", { description: e.message }),
  });

  if (!project) return null;
  const tz = project.timezone ?? localTimezone();
  const problems = draft ? draftProblems(draft, tz) : ["Loading"];
  const submit = (run: boolean) => draft && create.mutate({ draft, run });

  return (
    <>
      <PageHeader
        icon={<Workflow />}
        title={
          <span className="flex items-center gap-1.5">
            <Link
              to="/projects/$projectId/automations"
              params={{ projectId }}
              className="flex items-center text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-4" /> {project.name}
            </Link>
            <span className="text-muted-foreground">/</span>
            {template
              ? `New from ${template.name}`
              : fromSession
                ? `New from ${fromSession.title ?? fromSession.purpose}`
                : "New automation"}
          </span>
        }
        actions={
          <>
            <span className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Start enabled" />
              {enabled ? "Starts on" : "Starts off"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={problems.length > 0 || create.isPending}
              onClick={() => submit(true)}
            >
              <Play /> Save and run now
            </Button>
            <Button
              size="sm"
              disabled={problems.length > 0 || create.isPending}
              title={problems.join(" ")}
              onClick={() => submit(false)}
            >
              <Save /> {create.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-4xl space-y-3 px-6 py-6">
          {draft ? (
            <>
              <AutomationForm
                draft={draft}
                onChange={setDraft}
                projectTimezone={tz}
                defaultAutonomy={defaultAutonomy}
                docKey={`new:${sessionId ? `session:${sessionId}` : (templateId ?? "blank")}`}
                defaultWorkKey="automation:<name>"
              />
              {problems.length > 0 && (
                <p className="text-2xs text-muted-foreground" data-testid="draft-problems">
                  To save: {problems.join(" ")}
                </p>
              )}
            </>
          ) : (
            <Skeleton className="h-96 rounded-xl" />
          )}
        </div>
      </div>
    </>
  );
}
