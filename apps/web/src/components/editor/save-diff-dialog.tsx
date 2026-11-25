import { ShieldCheck } from "lucide-react";
import { MultiFileDiff } from "@/components/on-demand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDiffThemes } from "@/lib/theme/diff-theme";
import { useResolvedTheme } from "@/stores/theme";

/** Diff preview before overwriting a native file (§12.4): a backup is written first. */
export function SaveDiffDialog({
  open,
  onOpenChange,
  path,
  before,
  after,
  onConfirm,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  before: string;
  after: string;
  onConfirm: () => void;
  saving?: boolean;
}) {
  const theme = useResolvedTheme();
  const syntax = useDiffThemes();
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review changes to {name}</DialogTitle>
          <DialogDescription className="font-mono text-2xs">{path}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55dvh] overflow-auto rounded-lg border border-border scroll-thin">
          <MultiFileDiff
            oldFile={{ name, contents: before }}
            newFile={{ name, contents: after }}
            options={{
              theme: syntax,
              themeType: theme,
              diffStyle: "unified",
              overflow: "wrap",
              disableFileHeader: true,
            }}
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-status-done" /> A backup is saved before the file
            is overwritten.
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Keep editing
            </Button>
            <Button onClick={onConfirm} disabled={saving}>
              {saving ? "Saving…" : "Save to file"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
