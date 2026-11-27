import {
  type ProviderInfo,
  REVIEW_FOCUS_MAX,
  type ReviewSessionRequest,
  type Session,
  type SetupCheck,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, ScanSearch } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  type Availability,
  lowerFirst,
  type ModelChoice,
  providerAvailability,
} from "@/components/composer/model-picker/logic";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { useEnabledProviders } from "@/components/composer/model-picker/use-model-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { useRecheckSetup, useSession, useSetupStatus, useSnapshotData } from "@/lib/queries";
import { useReviewBlocked } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";
import { initialHandoffChoice } from "./handoff-dialog";

/**
 * The provider and model a review starts with: the one asked for, else the first other provider
 * that can run and enforce read-only (a second opinion is most independent on another
 * provider), else the session's own. Only providers reporting `capabilities.readOnly` are
 * candidates, never chosen by name. The same provider keeps the session's model and effort.
 */
export function initialReviewChoice(
  session: Session,
  providers: readonly ProviderInfo[],
  asked: string | null,
  checks?: readonly SetupCheck[],
): ModelChoice {
  const readOnly = providers.filter((p) => p.capabilities.readOnly);
  return initialHandoffChoice(session, readOnly, asked, checks);
}

/**
 * Why `target` can't review, or null when it can: it must be able to start (`availability`,
 * from the setup checks) and enforce read-only permissions natively (the server refuses the
 * same, §9). Read from `ProviderCapabilities`, never the provider's name.
 */
export function reviewTargetProblem(target: ProviderInfo | undefined, availability?: Availability) {
  if (!target) return null;
  if (availability && !availability.ready) {
    return `${target.displayName} can't start sessions: ${lowerFirst(availability.reason ?? "Not ready")}.`;
  }
  if (!target.capabilities.readOnly) {
    return `${target.displayName} can't run read-only sessions, so it can't review.`;
  }
  return null;
}

/**
 * Review a session's changes (§9): a new read-only session on the chosen provider with this
 * one's code and a review brief, then open it. Setting up its worktree waits for the source's
 * latest checkpoint, so a loading toast shows meanwhile.
 */
function useReviewSession(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  return useMutation({
    mutationFn: (req: ReviewSessionRequest) => client.reviewSession(session.id, req),
    onMutate: () => ({ toastId: toast.loading("Starting the review…") }),
    onSuccess: ({ sessionId }, req, context) => {
      const name = providers.find((p) => p.id === req.provider)?.displayName ?? req.provider;
      toast.success(`${name} is reviewing this session's changes`, {
        id: context?.toastId,
        description: "It works read-only on a copy of the code. This session is unchanged.",
      });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
    },
    onError: (error, _vars, context) =>
      toast.error(error instanceof Error ? error.message : String(error), {
        id: context?.toastId,
      }),
  });
}

/**
 * "Review with another agent" (§9): an independent, read-only review of a session's changes by
 * a new session, usually on another provider. Opened from the thread header's ⋯ menu, the
 * command palette or the GitHub panel's pull request section (`useUiStore().review`).
 */
export function ReviewDialog() {
  const target = useUiStore((s) => s.review);
  const setReview = useUiStore((s) => s.setReview);
  const session = useSession(target?.sessionId);
  const open = Boolean(target && session);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && setReview(null)}>
      {target && session && (
        <ReviewForm
          key={`${session.id}:${target.provider ?? ""}`}
          session={session}
          asked={target.provider}
          onDone={() => setReview(null)}
        />
      )}
    </Dialog>
  );
}

function ReviewForm({
  session,
  asked,
  onDone,
}: {
  session: Session;
  asked: string | null;
  onDone: () => void;
}) {
  const providers = useEnabledProviders(
    useSnapshotData((s) => s.runner.providers, []),
    session.provider,
  );
  const checks = useSetupStatus({ staleTime: 60_000 }).data?.checks;
  // Until the user picks, the default follows the setup checks as they arrive.
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const choice = picked ?? initialReviewChoice(session, providers, asked, checks);
  const [focus, setFocus] = useState("");
  const review = useReviewSession(session);
  const blocked = useReviewBlocked(session);
  const recheck = useRecheckSetup();
  const target = providers.find((p) => p.id === choice.provider);
  const name = target?.displayName ?? choice.provider;
  const availability = providerAvailability(choice.provider, checks);
  const problem = blocked ?? reviewTargetProblem(target, availability);
  const sameProvider = choice.provider === session.provider;
  const submit = () => {
    if (problem || review.isPending) return;
    review.mutate(
      {
        provider: choice.provider,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(focus.trim() ? { focus: focus.trim() } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <DialogContent className="sm:max-w-lg" data-testid="review-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ScanSearch className="size-4 text-muted-foreground" /> Review with another agent
        </DialogTitle>
        <DialogDescription>
          A new session reviews this session's changes and reports a verdict with its findings. It
          gets a copy of the code (a new branch with the uncommitted changes) and a brief of the
          task, and it's read-only: it can run checks but can't edit, commit or push. This session
          stays as it is.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Review with</Label>
          <div className="w-fit rounded-lg border border-border px-1 py-0.5">
            <ModelPicker
              providers={providers}
              projectId={session.projectId}
              value={choice}
              onChange={setPicked}
              disabled={review.isPending}
            />
          </div>
          {sameProvider && !problem && (
            <p className="text-xs text-muted-foreground">
              Same provider as this session. Another provider gives a more independent opinion.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="review-focus">
            What should it focus on?{" "}
            <span className="font-normal text-muted-foreground">Optional</span>
          </Label>
          <Textarea
            id="review-focus"
            value={focus}
            maxLength={REVIEW_FOCUS_MAX}
            rows={3}
            placeholder="Correctness, tests, security and the project's conventions"
            disabled={review.isPending}
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {problem && (
          <p className="text-xs text-status-waiting" role="status">
            {problem}
          </p>
        )}
        {target && !blocked && !availability.ready && (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {availability.command ? (
                <>
                  Run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">
                    {availability.command}
                  </code>{" "}
                  in a terminal, then check again.
                </>
              ) : (
                "Set it up, then check again."
              )}
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              {recheck.isPending ? "Checking…" : "Check again"}
            </Button>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={problem !== null || review.isPending}>
          {review.isPending && <Loader2 className="animate-spin" aria-hidden />}
          Start review on {name}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
