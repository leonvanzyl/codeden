import { Link } from "@tanstack/react-router";
import type { CSSProperties, Ref } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { cn } from "@/lib/utils";
import { QuickChat } from "../quick-chat";

/**
 * The PM chat as part of the floor (#264): a pixel-framed terminal docked beside the PM's control
 * room, inside the scene's frame. Inside it is the usual quick chat, so the text is readable, the
 * composer is the normal one and the messages scroll.
 */
export function PmTerminal({
  projectId,
  onFold,
  className,
  style,
  ref,
}: {
  projectId: string;
  onFold: () => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
}) {
  const session = useRoleSession("pm", projectId);
  const busy = session?.status === "running" || session?.status === "starting";
  return (
    <aside
      ref={ref}
      aria-label="Project manager chat"
      className={cn(
        "dark flex min-h-0 flex-col border-4 border-[#262b44] bg-[#1a1c2c] text-foreground shadow-[inset_0_0_0_2px_#3d4660]",
        className,
      )}
      style={style}
      data-testid="factory-view-pixel-terminal"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b-4 border-[#262b44] bg-[#29366f] px-2 font-mono text-[11px] text-[#f4f4f4]">
        <span
          aria-hidden
          className={cn(
            "size-2 border border-[#1a1c2c]",
            busy ? "bg-[#a7f070] motion-safe:animate-pulse" : "bg-[#566c86]",
          )}
        />
        <h2 className="font-semibold uppercase tracking-wider">PM terminal</h2>
        {busy && <span className="text-[#73eff7]">answering…</span>}
        <Link
          to="/projects/$projectId/pm"
          params={{ projectId }}
          className="ml-auto text-[#ffcd75] hover:underline"
        >
          Full chat
        </Link>
        <button
          type="button"
          onClick={onFold}
          className="border-2 border-[#1a1c2c] bg-[#566c86] px-1 leading-none hover:bg-[#6b7f9a]"
          aria-label="Fold the PM chat"
          data-testid="factory-view-pixel-terminal-fold"
        >
          –
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <QuickChat projectId={projectId} header={false} />
      </div>
    </aside>
  );
}
