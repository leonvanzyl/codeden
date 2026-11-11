import type {
  AutonomyLevel,
  ConflictRecord,
  ReasoningEffort,
  StartSessionRequestInit,
  StartSessionResponse,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "@/components/composer/pickers";
import { supportsReadOnly } from "@/components/thread/autonomy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { useProject, useSnapshotData } from "@/lib/queries";
import { ConflictCard, LOCAL_CONFLICT_PREFIX } from "./conflict-card";

interface Choice {
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  autonomy: AutonomyLevel | null;
  /** Start in plan mode (only sent when the provider reports `capabilities.planMode`). */
  planMode: boolean;
}

/** Start an agent session; shows the conflict card when matching work is already running. */
export function NewSessionDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useClient();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const defaultAutonomy = useSnapshotData<AutonomyLevel>(
    (s) => s.settings.autonomy.default,
    "auto",
  );
  const agentDefaults = useSnapshotData((s) => s.settings.providers.agent, null);
  const [prompt, setPrompt] = useState("");
  const [workKey, setWorkKey] = useState("");
  const [choice, setChoice] = useState<Choice>({
    provider: null,
    model: null,
    effort: null,
    autonomy: null,
    planMode: false,
  });
  const [conflict, setConflict] = useState<ConflictRecord | null>(null);

  const known = (id: string | null | undefined) =>
    id && providers.some((p) => p.id === id) ? id : null;
  const providerId =
    choice.provider ??
    known(project?.defaultProvider) ??
    known(agentDefaults?.provider) ??
    providers[0]?.id ??
    null;
  const provider = providers.find((p) => p.id === providerId);
  const model =
    provider?.models.find((m) => m.id === choice.model) ??
    provider?.models.find((m) => m.isDefault) ??
    provider?.models[0];
  const autonomy = choice.autonomy ?? project?.autonomy ?? defaultAutonomy;
  const planSupported = provider?.capabilities.planMode ?? false;
  const planMode = choice.planMode && planSupported;

  const start = useMutation({
    mutationFn: async () => {
      const request: StartSessionRequestInit = {
        projectId,
        input: { text: prompt.trim() },
        autonomy,
        ...(planMode ? { planMode: true } : {}),
        ...(providerId ? { provider: providerId } : {}),
        ...(model ? { model: model.id } : {}),
        ...(choice.effort && provider?.capabilities.reasoningEffort
          ? { effort: choice.effort }
          : {}),
        ...(workKey.trim() ? { workKey: workKey.trim() } : {}),
      };
      const result = await client.startSession(request);
      if (result.status !== "conflict") return { request, result, record: null };
      // The server persisted the conflict (409 with `conflictId`); show that record.
      const persisted = result.conflictId
        ? (await client.listConflicts({ projectId })).find((c) => c.id === result.conflictId)
        : undefined;
      const record: ConflictRecord = persisted ?? {
        id: `${LOCAL_CONFLICT_PREFIX}${Date.now()}`,
        projectId,
        request: {
          purpose: prompt.trim().split(/\r?\n/)[0] ?? "New session",
          workKey: workKey.trim() || result.existing[0]?.workKey || "request:new",
          startedBy: { kind: "user" },
        },
        existing: result.existing,
        start: JSON.parse(JSON.stringify(request)),
        status: "open",
        resolution: null,
        outcome: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      return { request, result, record };
    },
    onSuccess: ({
      result,
      record,
    }: {
      result: StartSessionResponse;
      record: ConflictRecord | null;
    }) => {
      if (result.status === "conflict") {
        setConflict(record);
        return;
      }
      onOpenChange(false);
      setPrompt("");
      setWorkKey("");
      if (result.status === "skipped") return;
      if (result.status === "queued") toast("Queued behind running work");
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
    },
    onError: (e) => toast.error("Couldn't start the session", { description: e.message }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setConflict(null);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent session</DialogTitle>
          <DialogDescription>
            Runs in its own worktree and branch. Duplicate work is detected before anything starts.
          </DialogDescription>
        </DialogHeader>
        {conflict ? (
          <ConflictCard
            conflict={conflict}
            onResolved={() => {
              setConflict(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ns-prompt">What should the agent do?</Label>
              <Textarea
                id="ns-prompt"
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) {
                    e.preventDefault();
                    start.mutate();
                  }
                }}
                placeholder="Add a README section describing this project and a tiny test…"
                className="min-h-28"
              />
            </div>
            <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border px-1 py-0.5">
              {provider ? (
                <ModelPicker
                  providers={providers}
                  value={{ provider: provider.id, model: choice.model, effort: choice.effort }}
                  onChange={(next) =>
                    setChoice((c) => {
                      const nextProvider = providers.find((p) => p.id === next.provider);
                      // Switching to a provider without plan mode turns the toggle off.
                      const keepPlan = nextProvider?.capabilities.planMode ?? false;
                      return { ...c, ...next, planMode: c.planMode && keepPlan };
                    })
                  }
                />
              ) : (
                <span className="px-2 text-xs text-muted-foreground">No agent provider ready</span>
              )}
              <AutonomyPicker
                value={autonomy}
                readOnlySupported={supportsReadOnly(provider)}
                onChange={(a) => setChoice((c) => ({ ...c, autonomy: a }))}
              />
              {planSupported && (
                <PlanToggle
                  value={planMode}
                  onChange={(on) => setChoice((c) => ({ ...c, planMode: on }))}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ns-key">
                Work key <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="ns-key"
                value={workKey}
                onChange={(e) => setWorkKey(e.target.value)}
                placeholder="issue:151 — sessions with the same key are flagged as duplicates"
                className="font-mono text-[13px]"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!prompt.trim() || start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? "Starting…" : "Start session"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
