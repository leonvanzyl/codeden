import { HANDOFF_NOTE_MAX, type ProviderInfo, type Session } from "@codeden/contracts";
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import type { ModelChoice } from "@/components/composer/model-picker/logic";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
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
import { useSession, useSnapshotData } from "@/lib/queries";
import { useHandoffBlocked, useHandoffSession } from "@/lib/session-actions";
import { useUiStore } from "@/stores/ui";

/**
 * The provider and model a handoff starts with: the one asked for, else the first other
 * provider (handing off is mostly about switching), else the session's own. The same provider
 * keeps the session's model and effort; another starts from its defaults.
 */
export function initialHandoffChoice(
  session: Session,
  providers: readonly ProviderInfo[],
  asked: string | null,
): ModelChoice {
  const provider =
    (asked && providers.some((p) => p.id === asked) ? asked : null) ??
    providers.find((p) => p.id !== session.provider)?.id ??
    session.provider;
  return provider === session.provider
    ? { provider, model: session.model, effort: session.effort }
    : { provider, model: null, effort: null };
}

/**
 * Why `target` can't take this session's permissions, or null when it can (the server refuses
 * the same, §9): read-only needs native enforcement, and a session still planning needs plan
 * mode. Read from `ProviderCapabilities`, never the provider's name.
 */
export function handoffTargetProblem(session: Session, target: ProviderInfo | undefined) {
  if (!target) return null;
  if (session.autonomy === "read_only" && !target.capabilities.readOnly) {
    return `${target.displayName} can't run read-only sessions. Change this session's permissions first.`;
  }
  if (session.planMode && !target.capabilities.planMode) {
    return `${target.displayName} has no plan mode, and this session is still planning. Approve or leave its plan first.`;
  }
  return null;
}

/**
 * "Hand off" (§9): continue a session in a new one, on any provider. Opened from the thread
 * header's ⋯ menu, the command palette or another provider's tile in the session's model
 * picker (`useUiStore().handoff`).
 */
export function HandoffDialog() {
  const target = useUiStore((s) => s.handoff);
  const setHandoff = useUiStore((s) => s.setHandoff);
  const session = useSession(target?.sessionId);
  const open = Boolean(target && session);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && setHandoff(null)}>
      {target && session && (
        <HandoffForm
          key={`${session.id}:${target.provider ?? ""}`}
          session={session}
          asked={target.provider}
          onDone={() => setHandoff(null)}
        />
      )}
    </Dialog>
  );
}

function HandoffForm({
  session,
  asked,
  onDone,
}: {
  session: Session;
  asked: string | null;
  onDone: () => void;
}) {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const [choice, setChoice] = useState(() => initialHandoffChoice(session, providers, asked));
  const [note, setNote] = useState("");
  const handoff = useHandoffSession(session);
  const blocked = useHandoffBlocked(session);
  const target = providers.find((p) => p.id === choice.provider);
  const name = target?.displayName ?? choice.provider;
  const problem = blocked ?? handoffTargetProblem(session, target);
  const submit = () => {
    if (problem || handoff.isPending) return;
    handoff.mutate(
      {
        provider: choice.provider,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <DialogContent className="sm:max-w-lg" data-testid="handoff-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-4 text-muted-foreground" /> Hand off this session
        </DialogTitle>
        <DialogDescription>
          Continue the work in a new session, on any provider. It starts from this session's code (a
          new branch with its uncommitted changes) and a brief of what was done. The conversation
          itself isn't copied, and this session stays as it is.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Continue with</Label>
          <div className="w-fit rounded-lg border border-border px-1 py-0.5">
            <ModelPicker providers={providers} value={choice} onChange={setChoice} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="handoff-note">
            What should it do next?{" "}
            <span className="font-normal text-muted-foreground">Optional</span>
          </Label>
          <Textarea
            id="handoff-note"
            value={note}
            maxLength={HANDOFF_NOTE_MAX}
            rows={3}
            placeholder="Continue where it left off"
            onChange={(e) => setNote(e.target.value)}
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
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={problem !== null || handoff.isPending}>
          Continue in new {name} session
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
