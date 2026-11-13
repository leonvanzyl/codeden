import type { Project, Role, Session, TranscriptSearchHit } from "@codeden/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, SearchX, TextSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common/bits";
import { StatusDot } from "@/components/common/status-dot";
import { SnippetText } from "@/components/search/snippet-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ago } from "@/lib/format";
import { useSnapshotData } from "@/lib/queries";
import {
  canSearchTranscripts,
  hitKindLabel,
  hitLinkSearch,
  roleBadge,
  type TranscriptSearchFilters,
  useDebouncedValue,
  useTranscriptSearchPages,
} from "@/lib/search";
import { PageHeader } from "./page-header";

const PAGE = 50;
const ALL = "all";
const ROLES: { value: Role; label: string }[] = [
  { value: "agent", label: "Agents" },
  { value: "pm", label: "PMs" },
  { value: "orchestrator", label: "Orchestrator" },
];

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
}: {
  hit: TranscriptSearchHit;
  session: Session | undefined;
  project: Project | undefined;
}) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: hit.sessionId }}
      search={hitLinkSearch(hit)}
      className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        {session && <StatusDot status={session.status} />}
        <span className="min-w-0 truncate font-medium">
          {session ? (session.title ?? session.purpose) : "Session"}
        </span>
        {project && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{project.name}</span>
        )}
        <Badge>{(session && roleBadge(session.role)) ?? "Agent"}</Badge>
        {session?.archivedAt && <Badge>Archived</Badge>}
        <span className="ml-auto shrink-0 pl-2 text-2xs text-muted-foreground" title={hit.ts}>
          {ago(hit.ts)}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 gap-2 text-xs leading-relaxed">
        <span className="w-16 shrink-0 text-muted-foreground/70">{hitKindLabel(hit)}</span>
        <SnippetText parts={hit.snippet} className="line-clamp-2 text-muted-foreground" />
      </div>
    </Link>
  );
}

function Results({ q, filters }: { q: string; filters: TranscriptSearchFilters }) {
  const sessions = useSnapshotData((s) => s.sessions, []);
  const projects = useSnapshotData((s) => s.projects, []);
  const { hits, query, error, searching, hasMore, loadingMore, loadMore } =
    useTranscriptSearchPages(q, { ...filters, limit: PAGE });

  if (!q.trim()) {
    return (
      <EmptyState icon={<TextSearch />} title="Search every transcript" className="py-16">
        Find what was asked, answered or run in any session, archived ones included: a message, a
        command, a file path.
      </EmptyState>
    );
  }
  if (!canSearchTranscripts(q)) {
    return (
      <EmptyState icon={<TextSearch />} title="Keep typing" className="py-16">
        Search needs a word of at least 3 characters.
      </EmptyState>
    );
  }
  if (error) {
    return (
      <EmptyState icon={<SearchX />} title="Couldn't search transcripts" className="py-16">
        {error.message}
      </EmptyState>
    );
  }
  if (!hits) {
    return (
      <div className="space-y-4 px-3 pt-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ))}
      </div>
    );
  }
  if (hits.length === 0 && !hasMore) {
    return (
      <EmptyState icon={<SearchX />} title="No matches" className="py-16">
        Nothing in{" "}
        {filters.projectId || filters.role || filters.includeArchived === false
          ? "these sessions"
          : "any transcript"}{" "}
        contains every word of “{query}”.
      </EmptyState>
    );
  }
  return (
    <div className={searching ? "opacity-70 transition-opacity" : undefined}>
      <div className="divide-y divide-border/60">
        {hits.map((hit) => {
          const session = sessions.find((s) => s.id === hit.sessionId);
          return (
            <HitRow
              key={`${hit.sessionId}:${hit.itemId}`}
              hit={hit}
              session={session}
              project={projects.find((p) => p.id === session?.projectId)}
            />
          );
        })}
      </div>
      {hasMore && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />}
            {hits.length === 0 ? "Search older transcripts" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The `/search` URL parameters for a query and its filters. */
function toSearch(q: string, f: TranscriptSearchFilters) {
  return {
    q: q || undefined,
    project: f.projectId,
    role: f.role,
    archived: f.includeArchived === false ? (false as const) : undefined,
  };
}

/** Project, role and archived filters for the results. */
function Filters({
  filters,
  onChange,
}: {
  filters: TranscriptSearchFilters;
  onChange: (next: TranscriptSearchFilters) => void;
}) {
  const projects = useSnapshotData((s) => s.projects, []);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select
        value={filters.projectId ?? ALL}
        onValueChange={(v) => onChange({ ...filters, projectId: v === ALL ? undefined : v })}
      >
        <SelectTrigger size="sm" className="w-44" aria-label="Project">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.role ?? ALL}
        onValueChange={(v) => onChange({ ...filters, role: v === ALL ? undefined : (v as Role) })}
      >
        <SelectTrigger size="sm" className="w-36" aria-label="Role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All roles</SelectItem>
          {ROLES.map((r) => (
            <SelectItem key={r.value} value={r.value}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="ml-1 flex items-center gap-2">
        <Switch
          id="search-archived"
          checked={filters.includeArchived !== false}
          onCheckedChange={(includeArchived) => onChange({ ...filters, includeArchived })}
        />
        <label htmlFor="search-archived" className="text-xs text-muted-foreground">
          Archived sessions
        </label>
      </span>
    </div>
  );
}

/**
 * Transcript search results (§13): every match for `q`, newest first, a page at a time, with
 * its session, project, role, archived state, a highlighted snippet and when it was said.
 * Filters by project and role and can leave out archived sessions. A match opens its session
 * there (and a subagent's thread at the item).
 */
export function SearchPage({ q, filters }: { q: string; filters: TranscriptSearchFilters }) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const settled = useDebouncedValue(text, 250);
  const lastSettled = useRef(settled);

  // Typing updates the URL once it settles; back and forward update the box.
  useEffect(() => {
    if (settled === lastSettled.current) return;
    lastSettled.current = settled;
    if (settled.trim() === q) return;
    void navigate({ to: "/search", search: toSearch(settled.trim(), filters), replace: true });
  }, [settled, q, filters, navigate]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only follow outside URL changes.
  useEffect(() => {
    if (q !== text.trim()) setText(q);
  }, [q]);

  return (
    <>
      <PageHeader
        icon={<TextSearch />}
        title="Search transcripts"
        meta="Messages, replies, commands and file paths across every session, newest first"
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-6">
          <div className="relative mb-3">
            <TextSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="webhook retry, prisma migrate, src/cart…"
              aria-label="Search transcripts"
              className="h-10 pl-9"
            />
          </div>
          <Filters
            filters={filters}
            onChange={(next) =>
              navigate({ to: "/search", search: toSearch(q, next), replace: true })
            }
          />
          <Results q={q} filters={filters} />
        </div>
      </div>
    </>
  );
}
