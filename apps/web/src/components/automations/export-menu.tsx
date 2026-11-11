import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ClipboardCopy, Download, FileArchive, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClient } from "@/lib/api";
import { notifyCopyFailed } from "@/lib/copy";
import { platform } from "@/lib/platform";

/** Save a blob as a file through a temporary link. */
export function saveBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Bytes of a base64 string. */
export function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Share one automation (§10): download it as `<slug>.md` or copy the Markdown. The file also
 * works dropped into `.codeden/automations/`.
 */
export function ExportMenu({ automationId }: { automationId: string }) {
  const client = useClient();
  const exp = useMutation({
    mutationFn: async (how: "download" | "copy") => {
      const file = await client.automations.exportOne(automationId);
      if (how === "download") {
        saveBlob(file.fileName, new Blob([file.markdown], { type: "text/markdown" }));
      } else {
        // Fetched first, so the gesture may have expired; a failed copy says so itself.
        const copied = await platform.writeClipboard(file.markdown);
        if (!copied) notifyCopyFailed();
        return { how, file, copied };
      }
      return { how, file, copied: false };
    },
    onSuccess: ({ how, file, copied }) => {
      if (how === "download") toast.success(`Downloaded ${file.fileName}`);
      else if (copied) toast.success("Copied as Markdown");
    },
    onError: (e) => toast.error("Couldn't export", { description: e.message }),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Share2 /> Export <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" data-testid="export-menu">
        <DropdownMenuItem onSelect={() => exp.mutate("download")}>
          <Download /> Download .md
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => exp.mutate("copy")}>
          <ClipboardCopy /> Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Export every automation of a project as a zip of `.md` files. */
export function ExportAllButton({ projectId }: { projectId: string }) {
  const client = useClient();
  const exp = useMutation({
    mutationFn: () => client.automations.exportAll(projectId),
    onSuccess: (res) => {
      if (res.count === 0) {
        toast.info("Nothing to export yet");
        return;
      }
      saveBlob(res.fileName, new Blob([base64Bytes(res.zipBase64)], { type: "application/zip" }));
      toast.success(`Exported ${res.count} automation${res.count === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error("Couldn't export", { description: e.message }),
  });
  return (
    <Button size="sm" variant="ghost" onClick={() => exp.mutate()} disabled={exp.isPending}>
      <FileArchive /> Export all
    </Button>
  );
}
