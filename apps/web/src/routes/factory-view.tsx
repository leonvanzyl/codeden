import { isFactoryMode } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { Bot, Factory, MessageSquare } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/bits";
import { useChatColumn, useNow, useWide } from "@/components/factory-view/hooks";
import { ItemSheet } from "@/components/factory-view/item-sheet";
import { PipelineBoard } from "@/components/factory-view/pipeline-board";
import { QuickChat } from "@/components/factory-view/quick-chat";
import { type SessionInfo, type ViewCard, viewPipeline } from "@/components/factory-view/stages";
import { StatsStrip } from "@/components/factory-view/stats-strip";
import { ViewHeader } from "@/components/factory-view/view-header";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryStatus } from "@/lib/factory";
import { useProject, useSnapshot, useSnapshotData } from "@/lib/queries";

const CHAT_KEY = "codeden.factoryView.chat";

/** Whether the PM chat column is open on wide screens; remembered across visits. */
function useChatOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(CHAT_KEY) !== "closed");
  return [
    open,
    (next) => {
      localStorage.setItem(CHAT_KEY, next ? "open" : "closed");
      setOpen(next);
    },
  ];
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {children}
    </div>
  );
}

/**
 * The Factory view (§10.1): a full-screen, calm view of one factory for a second screen. The
 * pipeline with every item as a card, a strip of figures, a quick line to the PM, and the
 * kill switch. Outside the app shell: no sidebar or side panels. Everything arrives over the
 * WebSocket, as on the factory panel.
 */
export function FactoryViewPage({ projectId }: { projectId: string }) {
  const { data: snapshot } = useSnapshot();
  const project = useProject(projectId);
  const factory = project ? isFactoryMode(project.autonomyMode) : false;
  const { data: f } = useFactoryStatus(projectId, factory);
  const sessionList = useSnapshotData((s) => s.sessions, []);
  const sessions = useMemo(
    () =>
      new Map<string, SessionInfo>(
        sessionList.map((s) => [s.id, { status: s.status, progress: s.progress?.text ?? null }]),
      ),
    [sessionList],
  );
  const now = useNow();
  const pipeline = useMemo(() => (f ? viewPipeline(f, sessions, now) : null), [f, sessions, now]);
  const wide = useWide();
  // The chat sits beside the pipeline only where six readable columns still fit next to it.
  const chatColumn = useChatColumn();
  const [chatOpen, setChatOpen] = useChatOpen();
  const [chatSheet, setChatSheet] = useState(false);
  // The open card by id, so its sheet follows the card as it moves.
  const [selected, setSelected] = useState<ViewCard | null>(null);
  const current = useMemo(() => {
    if (!selected || !pipeline) return selected;
    const all = [...Object.values(pipeline.stages).flat(), ...pipeline.needsYou];
    return all.find((c) => c.item.id === selected.item.id) ?? selected;
  }, [selected, pipeline]);

  if (!snapshot)
    return (
      <Frame>
        <Skeleton className="m-6 h-72 rounded-xl" />
      </Frame>
    );
  if (!project)
    return (
      <Frame>
        <EmptyState icon={<Factory />} title="Project not found" className="flex-1">
          <Link to="/" className="text-primary hover:underline">
            Back to CodeDen
          </Link>
        </EmptyState>
      </Frame>
    );
  if (!factory)
    return (
      <Frame>
        <EmptyState
          icon={<Factory />}
          title="Not a factory project"
          className="flex-1"
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to="/projects/$projectId" params={{ projectId }}>
                Back to the project
              </Link>
            </Button>
          }
        >
          {project.name} isn't in software factory or dark factory mode, so there's no factory to
          show.
        </EmptyState>
      </Frame>
    );
  if (!f || !pipeline)
    return (
      <Frame>
        <div className="h-14 border-b border-border" />
        <div className="space-y-3 p-4">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </Frame>
    );

  return (
    <Frame>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="factory-view">
        <ViewHeader
          project={project}
          f={f}
          needsPerson={pipeline.needsPerson}
          failed={pipeline.failed}
        />
        <div className="flex min-h-0 flex-1">
          <main
            className={
              wide
                ? // Scrolls only when the window is too short for the figures, the lane and a
                  // usable pipeline together.
                  "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 scroll-thin"
                : "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pb-20"
            }
          >
            <StatsStrip f={f} />
            <PipelineBoard f={f} pipeline={pipeline} now={now} onOpen={setSelected} />
          </main>
          {chatColumn && chatOpen && (
            <aside
              className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface/40 2xl:w-[400px]"
              aria-label="Project manager chat"
            >
              <QuickChat projectId={projectId} onCollapse={() => setChatOpen(false)} />
            </aside>
          )}
          {wide && !(chatColumn && chatOpen) && (
            <button
              type="button"
              onClick={() => (chatColumn ? setChatOpen(true) : setChatSheet(true))}
              className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border py-3 text-2xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Show the PM chat"
              data-testid="factory-view-chat-show"
            >
              <Bot className="size-4 text-primary" aria-hidden />
              <span className="[writing-mode:vertical-rl]">PM chat</span>
            </button>
          )}
        </div>
        {!wide && (
          <Button
            className="fixed right-4 bottom-4 z-10 rounded-full shadow-lg"
            onClick={() => setChatSheet(true)}
            data-testid="factory-view-chat-open"
          >
            <MessageSquare /> PM chat
          </Button>
        )}
        {!chatColumn && (
          // Narrower screens: the chat slides in from the right (tablets in landscape, small
          // laptops) or up from the bottom (phones, portrait tablets).
          <Sheet open={chatSheet} onOpenChange={setChatSheet}>
            <SheetContent
              side={wide ? "right" : "bottom"}
              showCloseButton={false}
              className="gap-0 p-0 data-[side=bottom]:h-[85dvh] data-[side=bottom]:rounded-t-2xl data-[side=right]:w-[min(26rem,90vw)] data-[side=right]:sm:max-w-none"
            >
              <SheetTitle className="sr-only">Project manager chat</SheetTitle>
              <SheetDescription className="sr-only">
                The latest messages with this project's PM
              </SheetDescription>
              <QuickChat projectId={projectId} onCollapse={() => setChatSheet(false)} />
            </SheetContent>
          </Sheet>
        )}
        <ItemSheet projectId={projectId} card={current} onClose={() => setSelected(null)} />
      </div>
    </Frame>
  );
}
