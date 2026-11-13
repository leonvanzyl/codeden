import type { CreateProjectRequest, Snapshot } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, GitBranch } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { snapshotKey } from "@/lib/queries";
import { withCreatedProject } from "@/lib/snapshot-reducer";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import { FolderBrowser } from "./folder-browser";
import { NativeFolderField } from "./native-folder-field";

/** Pick a local folder (server-side picker) or clone a GitHub repo. Shared by setup and the sidebar. */
export function ProjectSourcePicker({
  onCreated,
  submitLabel = "Add project",
}: {
  onCreated: (projectId: string) => void;
  submitLabel?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<"folder" | "clone">("folder");
  const [folder, setFolder] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const create = useMutation({
    mutationFn: (input: CreateProjectRequest) => client.createProject(input),
    onSuccess: ({ project, detected }) => {
      // Known before its live event arrives, so the page `onCreated` opens never says "not found".
      queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
        s ? withCreatedProject(s, project) : s,
      );
      const facts = [
        detected.github ? `GitHub ${detected.github.owner}/${detected.github.repo}` : null,
        detected.packageManager ? `Detected ${detected.packageManager}` : null,
        detected.suggestedSetupCommands.length
          ? `suggested setup: ${detected.suggestedSetupCommands.join(" && ")}`
          : null,
      ].filter(Boolean);
      toast.success(`Added ${project.name}`, {
        description: facts.length ? facts.join(" · ") : undefined,
      });
      onCreated(project.id);
    },
    onError: (e) => toast.error("Couldn't add the project", { description: e.message }),
  });
  const valid =
    source === "folder"
      ? Boolean(folder)
      : /^((https:\/\/|git@)github\.com[:/].+\/.+|[\w.-]+\/[\w.-]+)$/.test(url.trim());

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            [
              "folder",
              FolderOpen,
              "Local folder",
              "Any folder; GitHub features turn on when it has a GitHub remote.",
            ],
            [
              "clone",
              GitBranch,
              "Clone from GitHub",
              "Paste a repository URL and CodeDen clones it.",
            ],
          ] as const
        ).map(([id, Icon, title, desc]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSource(id)}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors",
              source === id
                ? "border-primary/50 bg-primary/[0.06]"
                : "border-border hover:bg-accent/40",
            )}
          >
            <Icon
              className={cn(
                "mb-2 size-4",
                source === id ? "text-primary" : "text-muted-foreground",
              )}
            />
            <div className="text-[13px] font-medium">{title}</div>
            <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">{desc}</div>
          </button>
        ))}
      </div>
      {source === "folder" ? (
        platform.capabilities.folderPicker ? (
          <NativeFolderField value={folder} onChange={setFolder} />
        ) : (
          <FolderBrowser value={folder} onChange={setFolder} />
        )
      ) : (
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="font-mono text-[13px]"
          autoFocus
        />
      )}
      <div className="flex justify-end">
        <Button
          disabled={!valid || create.isPending}
          onClick={() =>
            create.mutate(
              source === "folder"
                ? { source: { type: "local", path: folder ?? "" } }
                : { source: { type: "clone", url: url.trim() } },
            )
          }
        >
          {create.isPending ? (source === "clone" ? "Cloning…" : "Adding…") : submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function AddProjectDialog() {
  const open = useUiStore((s) => s.addProjectOpen);
  const setOpen = useUiStore((s) => s.setAddProjectOpen);
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            GitHub repos get issues, PRs and evidence. Local folders work too.
          </DialogDescription>
        </DialogHeader>
        <ProjectSourcePicker
          onCreated={(projectId) => {
            setOpen(false);
            // A new project's next step is a session: open its New session view.
            void navigate({ to: "/projects/$projectId/new", params: { projectId } });
          }}
        />
        <DialogFooter className="hidden" />
      </DialogContent>
    </Dialog>
  );
}
