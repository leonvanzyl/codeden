import type { AgentConfigDiff } from "@codeden/contracts";
import { Loader2, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A unified patch from the server, one coloured line per row. */
export function PatchView({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <pre className="min-w-max py-1 font-mono text-[11.5px] leading-5" data-testid="patch-view">
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: patch lines are static
          key={i}
          className={cn(
            "px-3",
            line.startsWith("+++") || line.startsWith("---")
              ? "text-muted-foreground"
              : line.startsWith("@@")
                ? "bg-primary/8 text-primary"
                : line.startsWith("+")
                  ? "bg-status-done/12 text-status-done"
                  : line.startsWith("-")
                    ? "bg-status-failed/12 text-status-failed"
                    : "text-foreground/80",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * Review a change to a native agent-config file before it is written (§12.4). The diff comes
 * from the server's diff endpoint, so it is exactly what the write will do; a backup of the
 * current file is taken before overwriting.
 */
export function PatchDialog({
  open,
  onOpenChange,
  title,
  diff,
  error,
  onConfirm,
  saving,
  confirmLabel = "Save to file",
  note,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  diff: AgentConfigDiff | undefined;
  error?: string | null;
  onConfirm: () => void;
  saving?: boolean;
  confirmLabel?: string;
  /** A line above the diff saying what the change means. */
  note?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="patch-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="font-mono text-2xs break-all">
            {diff?.absolutePath ?? "Preparing the diff…"}
            {diff && (
              <span className="ml-2 font-sans">
                <span className="text-status-done">+{diff.additions}</span>{" "}
                <span className="text-status-failed">−{diff.deletions}</span>
                {!diff.exists && " · new file"}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <div className="max-h-[55dvh] min-h-24 overflow-auto rounded-lg border border-border bg-background/60 scroll-thin">
          {error ? (
            <p className="p-4 text-xs text-status-failed">{error}</p>
          ) : !diff ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Asking the server for the diff…
            </div>
          ) : diff.changed ? (
            <PatchView patch={diff.patch} />
          ) : (
            <p className="p-4 text-xs text-muted-foreground">No changes to write.</p>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-status-done" />
            {diff?.exists === false
              ? "Creates the file in place."
              : "The current file is backed up to CodeDen's backups folder first."}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Keep editing
            </Button>
            <Button onClick={onConfirm} disabled={saving || !diff?.changed}>
              {saving ? "Saving…" : confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
