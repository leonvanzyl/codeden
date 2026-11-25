import { Link } from "@tanstack/react-router";
import { Keyboard, Moon, Settings, SlidersHorizontal, Sun } from "lucide-react";
import { StatusDot } from "@/components/common/status-dot";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMockMode } from "@/lib/api";
import { runnerStatusText } from "@/lib/runner-status";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";
import { resolveTheme, useThemeStore } from "@/stores/theme";
import { useUiStore } from "@/stores/ui";

function IconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Runner status line plus quick actions. `compact` renders a vertical stack for the rail. */
export function SidebarFooter({ compact = false }: { compact?: boolean }) {
  const runner = useConnectionStore((s) => s.runner);
  const socket = useConnectionStore((s) => s.socket);
  const preference = useThemeStore((s) => s.preference);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const openShortcuts = useUiStore((s) => s.setShortcutsOpen);
  const dark = resolveTheme(preference) === "dark";

  const { tone, label, detail } = runnerStatusText(socket, runner);

  return (
    <div
      className={cn(
        "flex border-t border-sidebar-border p-2",
        compact ? "flex-col items-center gap-1" : "items-center gap-0.5",
      )}
    >
      {!compact && (
        <div
          className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-2xs text-muted-foreground"
          role="status"
          title={detail}
        >
          <StatusDot tone={tone} />
          <span className={runner?.responsive === false ? "min-w-0 wrap-break-word" : "truncate"}>
            {label}
          </span>
          {isMockMode && (
            <span className="rounded border border-border px-1 text-3xs tracking-wide text-muted-foreground/80 uppercase">
              mock
            </span>
          )}
        </div>
      )}
      {compact && (
        <div role="status" title={detail}>
          <StatusDot tone={tone} className="mb-1" />
          <span className="sr-only">{label}</span>
        </div>
      )}
      <IconButton label="Keyboard shortcuts" onClick={() => openShortcuts(true)}>
        <Keyboard />
      </IconButton>
      <IconButton label={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
        {dark ? <Sun /> : <Moon />}
      </IconButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Agent configuration"
            asChild
          >
            <Link to="/agents">
              <SlidersHorizontal />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Agent configuration</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Settings"
            asChild
          >
            <Link to="/settings/$section" params={{ section: "general" }}>
              <Settings />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
    </div>
  );
}
