import { ChevronRight, Layers } from "lucide-react";
import { useState } from "react";
import { ImageGallery, ImageThumbnail } from "@/components/common/image-viewer";
import { useClient } from "@/lib/api";
import { duration } from "@/lib/format";
import { summarizeWork, type WorkEntry } from "@/lib/transcript/timeline";
import { cn } from "@/lib/utils";
import { entryLabel, imageArtifacts } from "./tool-meta";
import { ToolRow } from "./tool-row";

/** Images produced by `generate_image` calls stay visible even when the group is collapsed. */
function GeneratedImages({ entries }: { entries: WorkEntry[] }) {
  const client = useClient();
  const ids = entries.flatMap(imageArtifacts);
  if (ids.length === 0) return null;
  const images = ids.map((id, i) => ({
    src: client.artifactUrl(id),
    name: ids.length > 1 ? `Generated image ${i + 1}` : "Generated image",
  }));
  return (
    <ImageGallery images={images}>
      <div className="mt-2 ml-6 flex flex-wrap gap-2">
        {ids.map((id, i) => (
          <ImageThumbnail
            key={id}
            index={i}
            className="group/img block overflow-hidden rounded-xl border border-border shadow-xs"
          >
            <img
              src={client.artifactUrl(id)}
              alt="Generated"
              className="h-40 w-auto object-cover transition-transform duration-300 group-hover/img:scale-[1.02]"
            />
          </ImageThumbnail>
        ))}
      </div>
    </ImageGallery>
  );
}

/**
 * Consecutive tool calls and reasoning of a turn, collapsed into one sentence
 * ("Edited 2 files, ran 3 commands and 4 more"). While live, the running step shows beneath.
 */
export function WorkGroup({
  sessionId,
  entries,
  live,
}: {
  sessionId: string;
  entries: WorkEntry[];
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (entries.length === 1 && entries[0]) {
    return (
      <div>
        <ToolRow sessionId={sessionId} entry={entries[0]} />
        <GeneratedImages entries={entries} />
      </div>
    );
  }
  const current = live ? [...entries].reverse().find((e) => e.status === "in_progress") : undefined;
  const failed = entries.filter((e) => e.status === "failed").length;
  const total = entries.reduce(
    (ms, e) => ms + (e.kind === "tool_call" ? (e.durationMs ?? 0) : 0),
    0,
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/wg flex h-[26px] pointer-coarse:h-10 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-accent/50"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Layers className="size-3.5" />
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{summarizeWork(entries)}</span>
        {failed > 0 && (
          <span className="shrink-0 rounded bg-status-failed/12 px-1.5 text-3xs font-medium text-status-failed">
            {failed} failed
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <span className="text-3xs text-muted-foreground/60 tabular-nums">
            {entries.length} steps{total > 0 ? ` · ${duration(total)}` : ""}
          </span>
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
      </button>

      {open ? (
        <div className="relative mt-0.5 ml-[13px] border-l border-border pl-2.5">
          {entries.map((e) => (
            <ToolRow key={e.id} sessionId={sessionId} entry={e} />
          ))}
        </div>
      ) : (
        current && (
          <div
            className="relative mt-0.5 ml-[13px] border-l border-border pl-2.5"
            title={`Now: ${entryLabel(current).verb}`}
          >
            <ToolRow sessionId={sessionId} entry={current} />
          </div>
        )
      )}
      <GeneratedImages entries={entries} />
    </div>
  );
}
