import type { ForkOrigin, Session } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { Brain } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderMark } from "@/components/common/bits";
import { AutonomyBadge } from "@/components/thread/autonomy";
import { Switch } from "@/components/ui/switch";
import { SessionCostText } from "@/components/usage/session-cost";
import { forkOriginText, isHandoff } from "@/lib/fork-origin";
import { ago, compact, statusLabel } from "@/lib/format";
import { useSession } from "@/lib/queries";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useVoiceStore } from "@/stores/voice";
import { LoadedConfig } from "./loaded-config";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-baseline gap-3 py-1.5 text-[13px]">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const startedByLabel = {
  user: "You",
  orchestrator: "Orchestrator",
  pm: "Project manager",
  automation: "Automation",
};

/**
 * The session a fork or a handoff came from, the checkpoint its worktree started at and, for a
 * fork from a turn ("Fork from here"), where its conversation ends (§9).
 */
function ForkedFromRow({ origin }: { origin: ForkOrigin }) {
  const source = useSession(origin.sessionId);
  const text = forkOriginText(origin);
  return (
    <Row label={isHandoff(origin) ? "Handed off from" : "Forked from"}>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: origin.sessionId }}
        className="underline-offset-2 hover:underline"
      >
        {source ? (source.title ?? source.purpose) : origin.sessionId}
      </Link>
      <span className="block text-2xs text-muted-foreground">{text.code}</span>
      {text.conversation && (
        <span className="block text-2xs text-muted-foreground">{text.conversation}</span>
      )}
    </Row>
  );
}

/**
 * How full the context window is, as the provider last reported it in this view, and the
 * session's cost from the usage ledger. A figure that wasn't reported shows as "—" (§12.6).
 */
function ContextWindow({ sessionId }: { sessionId: string }) {
  const usage = useTranscriptsStore((s) => s.byId[sessionId]?.usage ?? null);
  const used = usage?.contextTokens;
  const size = usage?.contextWindow;
  const pct = used !== undefined && size ? Math.min(100, (used / size) * 100) : null;
  const reading =
    used === undefined && size === undefined
      ? "—"
      : `${used !== undefined ? compact(used) : "—"} / ${size ? compact(size) : "—"} tokens`;
  return (
    <section className="space-y-2">
      <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
        Context window
      </h3>
      {pct !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="flex justify-between gap-3 text-2xs text-muted-foreground tabular-nums">
        <span title={pct === null ? "Not reported by the provider yet" : undefined}>{reading}</span>
        <SessionCostText sessionId={sessionId} />
      </div>
    </section>
  );
}

/** Session metadata, usage and what's loaded into its context (§8.4, §12.4). */
export function DetailsPanel({ session }: { session: Session }) {
  const muted = useVoiceStore((s) => Boolean(s.muted[session.id]));
  const setMuted = useVoiceStore((s) => s.setMuted);

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4 scroll-thin">
      <section className="divide-y divide-border/60">
        <Row label="Status">
          {statusLabel[session.status]}
          {session.progress && (
            <span className="block text-2xs text-muted-foreground">{session.progress.text}</span>
          )}
        </Row>
        <Row label="Purpose">{session.purpose}</Row>
        <Row label="Work key">
          <code className="font-mono text-[12px]">{session.workKey}</code>
        </Row>
        <Row label="Started by">
          {startedByLabel[session.startedBy.kind]} · {ago(session.createdAt)}
        </Row>
        {session.forkedFrom && <ForkedFromRow origin={session.forkedFrom} />}
        <Row label="Provider">
          <span className="inline-flex items-center gap-1.5">
            <ProviderMark provider={session.provider} /> {session.provider} ·{" "}
            {session.model ?? "default"}
            {session.effort ? ` · ${session.effort}` : ""}
          </span>
        </Row>
        <Row label="Autonomy">
          <AutonomyBadge level={session.autonomy} />
        </Row>
        {session.branch && (
          <Row label="Branch">
            <code className="font-mono text-[12px]">{session.branch}</code>{" "}
            <span className="text-2xs text-muted-foreground">from {session.baseBranch}</span>
          </Row>
        )}
        {session.worktreePath && (
          <Row label="Worktree">
            <code className="font-mono text-[11.5px] text-muted-foreground">
              {session.worktreePath}
            </code>
          </Row>
        )}
        {session.scope.paths && (
          <Row label="Scope">
            <code className="font-mono text-[12px]">{session.scope.paths.join(", ")}</code>
          </Row>
        )}
      </section>

      <ContextWindow sessionId={session.id} />

      <LoadedConfig sessionId={session.id} projectId={session.projectId} />
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span>
          Read this session aloud
          <span className="block text-2xs text-muted-foreground">
            When read-aloud is on in Settings › Voice
          </span>
        </span>
        <Switch
          checked={!muted}
          onCheckedChange={(on) => setMuted(session.id, !on)}
          aria-label="Read this session aloud"
        />
      </div>
      <p className="flex items-center gap-1.5 text-3xs text-muted-foreground/70">
        <Brain className="size-3" /> Session {session.id} · resumable
        {session.resumeToken ? "" : " after first turn"}
      </p>
    </div>
  );
}
