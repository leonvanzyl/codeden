import type { Project, Session, TranscriptSearchHit } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { defaultFilter } from "cmdk";
import { TextSearch } from "lucide-react";
import { StatusDot } from "@/components/common/status-dot";
import { SnippetText } from "@/components/search/snippet-text";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { ageShort } from "@/lib/format";
import { canSearchTranscripts, hitKindLabel, roleBadge, useTranscriptSearch } from "@/lib/search";

const HIT = "transcript-hit:";
const ALL = "transcript-all:";

/**
 * The palette's filter: transcript rows are already matches (the server searched), so they
 * always show, ranked just below every title match so their group sits under them.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  if (value.startsWith(HIT)) return 0.002;
  if (value.startsWith(ALL)) return 0.001;
  return defaultFilter(value, search, keywords);
}

function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-sm border border-border px-1 text-3xs text-muted-foreground">
      {children}
    </span>
  );
}

function HitRow({
  hit,
  session,
  project,
  onSelect,
}: {
  hit: TranscriptSearchHit;
  session: Session | undefined;
  project: Project | undefined;
  onSelect: () => void;
}) {
  const role = session ? roleBadge(session.role) : null;
  return (
    <CommandItem
      value={`${HIT}${hit.sessionId}:${hit.itemId}`}
      onSelect={onSelect}
      className="flex-col items-stretch gap-0.5"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {session ? <StatusDot status={session.status} /> : <TextSearch />}
        </span>
        <span className="min-w-0 truncate">
          {session ? (session.title ?? session.purpose) : "Session"}
        </span>
        {project && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{project.name}</span>
        )}
        {role && <Badge>{role}</Badge>}
        {session?.archivedAt && <Badge>Archived</Badge>}
        <span className="flex-1" />
        <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
          {ageShort(hit.ts)}
        </span>
      </div>
      <div className="flex min-w-0 gap-1.5 pl-6.5 text-xs text-muted-foreground">
        <span className="shrink-0 text-muted-foreground/70">{hitKindLabel(hit)}</span>
        <SnippetText parts={hit.snippet} className="truncate" />
      </div>
    </CommandItem>
  );
}

/**
 * "Transcripts" in the command palette: the best transcript matches for what's typed (3+
 * characters), and a row that opens the full results.
 */
export function PaletteTranscripts({
  search,
  sessions,
  projects,
  close,
}: {
  search: string;
  sessions: Session[];
  projects: Project[];
  close: () => void;
}) {
  const navigate = useNavigate();
  const { data, searching, error } = useTranscriptSearch(search, { limit: 5 });
  if (!canSearchTranscripts(search)) return null;
  const q = search.trim();

  const open = (hit: TranscriptSearchHit) => {
    close();
    navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: hit.sessionId },
      search: { item: hit.anchorItemId },
    });
  };

  const note = error
    ? "Couldn't search transcripts"
    : !data
      ? "Searching transcripts…"
      : data.hits.length === 0 && !searching
        ? "No matches in transcripts"
        : null;

  return (
    <CommandGroup heading="Transcripts">
      {data?.hits.map((hit) => {
        const session = sessions.find((s) => s.id === hit.sessionId);
        return (
          <HitRow
            key={`${hit.sessionId}:${hit.itemId}`}
            hit={hit}
            session={session}
            project={projects.find((p) => p.id === session?.projectId)}
            onSelect={() => open(hit)}
          />
        );
      })}
      {note && <div className="px-2 py-1.5 pl-9 text-xs text-muted-foreground">{note}</div>}
      <CommandItem
        value={`${ALL}${q}`}
        onSelect={() => {
          close();
          navigate({ to: "/search", search: { q } });
        }}
        className="gap-2.5"
      >
        <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-4">
          <TextSearch />
        </span>
        <span className="min-w-0 truncate">
          Search all transcripts for <span className="font-medium">“{q}”</span>
        </span>
      </CommandItem>
    </CommandGroup>
  );
}
