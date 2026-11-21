import { GROUP_MEMORY_MAX_BYTES, type GroupMemory as Memory } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { ApiRequestError } from "@/lib/api/http";
import { ago } from "@/lib/format";
import { groupMemoryKey, useGroupMemory } from "@/lib/groups";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * The editor for one loaded memory. It holds the text and the revision the user started from;
 * a newer revision arriving (another write) never replaces unsaved text on its own, and Save
 * stays off until the user reloads.
 */
function MemoryEditor({ groupId, memory }: { groupId: string; memory: Memory }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [text, setText] = useState(memory.content);
  const [base, setBase] = useState({ revision: memory.revision, content: memory.content });
  const [busy, setBusy] = useState(false);
  const dirty = text !== base.content;
  const stale = memory.revision !== base.revision;
  const tooBig = byteLength(text) > GROUP_MEMORY_MAX_BYTES;

  const adopt = (next: Memory) => {
    setText(next.content);
    setBase({ revision: next.revision, content: next.content });
  };
  // Nothing typed yet: follow the other write instead of asking about it.
  if (stale && !dirty) adopt(memory);

  async function save() {
    setBusy(true);
    try {
      const saved = await client.groups.writeMemory(groupId, {
        content: text,
        mode: "replace",
        baseRevision: base.revision,
      });
      queryClient.setQueryData(groupMemoryKey(groupId), saved);
      adopt(saved);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "memory_changed") {
        void queryClient.invalidateQueries({ queryKey: groupMemoryKey(groupId) });
        toast.error("Someone else wrote to this memory", {
          description: "Reload their version before saving.",
        });
      } else {
        toast.error("Couldn't save the memory", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3.5">
      {stale && dirty && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13px]"
        >
          <span className="min-w-0 flex-1">
            Someone else wrote to this memory while you were editing. Saving now would overwrite
            their change.
          </span>
          <Button size="sm" variant="outline" onClick={() => adopt(memory)}>
            Reload their version
          </Button>
        </div>
      )}
      <Textarea
        aria-label="Group memory"
        value={text}
        rows={14}
        className="font-mono text-[13px]"
        placeholder="Nothing written yet."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <span className="flex-1 text-2xs text-muted-foreground">
          {memory.revision === 0
            ? "Not written yet"
            : `Revision ${memory.revision}${memory.updatedAt ? `, updated ${ago(memory.updatedAt)}` : ""}`}
          {tooBig && (
            <span className="ml-2 text-destructive">
              Over the {GROUP_MEMORY_MAX_BYTES.toLocaleString()} byte limit
            </span>
          )}
        </span>
        <Button size="sm" disabled={!dirty || busy || tooBig || stale} onClick={() => void save()}>
          Save memory
        </Button>
      </div>
    </div>
  );
}

export function GroupMemory({ groupId }: { groupId: string }) {
  const { data, isError, error } = useGroupMemory(groupId);
  return (
    <SettingsSection
      title="Memory"
      description="Shared facts for every project in this group. PMs and agents of member projects read and write it; project-specific facts belong in the project's notes."
    >
      {data ? (
        <MemoryEditor groupId={groupId} memory={data} />
      ) : (
        <div className="px-4 py-3.5 text-[13px] text-muted-foreground">
          {isError ? `Couldn't load the memory: ${error.message}` : "Loading…"}
        </div>
      )}
    </SettingsSection>
  );
}
