import {
  Bot,
  FileDiff,
  Files,
  GitPullRequest,
  Globe,
  Info,
  type LucideIcon,
  SquareTerminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type RightTab, useLayoutStore } from "@/stores/layout";
import { BrowserPanel } from "./browser-panel";
import { ChildThreadPanel } from "./child-thread-panel";
import { DetailsPanel } from "./details-panel";
import { DiffPanel } from "./diff-panel";
import { FilesPanel } from "./files-panel";
import { GitHubPanel } from "./github-panel";
import { TerminalView } from "./terminal-view";

const TABS: { id: RightTab; label: string; icon: LucideIcon }[] = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "files", label: "Files", icon: Files },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "github", label: "Issue / PR", icon: GitPullRequest },
  { id: "details", label: "Details", icon: Info },
];

/** Right panel (§13): diff, files, browser, terminal, issue/PR, details, and subagent threads. */
export function RightPanel({ sessionId, width }: { sessionId: string; width: number | string }) {
  const tab = useLayoutStore((s) => s.rightTab);
  const openTab = useLayoutStore((s) => s.openRightTab);
  const toggleRight = useLayoutStore((s) => s.toggleRight);
  const child = useLayoutStore((s) => s.childThread);
  const session = useSession(sessionId);
  const showChild = child && child.sessionId === sessionId;
  const active = tab === "thread" && !showChild ? "diff" : tab;

  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col bg-panel">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scroll-thin"
          role="tablist"
        >
          {showChild && (
            <TabButton
              active={active === "thread"}
              onClick={() => openTab("thread")}
              icon={Bot}
              label="Subagent"
              accent
            />
          )}
          {TABS.map((t) => (
            <TabButton
              key={t.id}
              active={active === t.id}
              onClick={() => openTab(t.id)}
              icon={t.icon}
              label={t.label}
              compact={typeof width === "number" && width < 470}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          onClick={() => toggleRight(false)}
          aria-label="Close panel"
        >
          <X />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {active === "diff" && <DiffPanel sessionId={sessionId} />}
        {active === "files" && <FilesPanel sessionId={sessionId} />}
        {active === "browser" && <BrowserPanel sessionId={sessionId} />}
        {active === "terminal" && <TerminalView key={sessionId} sessionId={sessionId} />}
        {active === "github" && <GitHubPanel sessionId={sessionId} />}
        {active === "details" && session && <DetailsPanel session={session} />}
        {active === "thread" && showChild && (
          <ChildThreadPanel
            key={`${child.threadId}:${child.focusItemId ?? ""}`}
            sessionId={sessionId}
            threadId={child.threadId}
            focusItemId={child.focusItemId}
          />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  compact,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  compact?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        active && "bg-accent text-foreground",
        accent && "text-chart-4",
      )}
    >
      <Icon className="size-3.5" />
      {(!compact || active) && label}
    </button>
  );
}
