import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { AddProjectDialog } from "@/components/setup/add-project-dialog";
import { HandoffDialog } from "@/components/thread/handoff-dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { RightPanel } from "@/components/workbench/right-panel";
import { TerminalDrawer } from "@/components/workbench/terminal-drawer";
import { useSession, useSnapshot } from "@/lib/queries";
import { useViewport } from "@/lib/viewport";
import { DRAWER, RIGHT, SIDEBAR, useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { CommandPalette } from "./command-palette";
import { LiveEffects } from "./live-effects";
import { MobileNavDrawer } from "./mobile-nav";
import { ResizeHandle } from "./resize-handle";
import { ShortcutsDialog, useGlobalShortcuts } from "./shortcuts";
import { Sidebar } from "./sidebar/sidebar";
import { SidebarRail } from "./sidebar/sidebar-rail";
import { UpdateBanner } from "./update-banner";

/** The session shown in the centre, if the current route is a thread. */
export function useCurrentSessionId(): string | undefined {
  const params = useParams({ strict: false }) as { sessionId?: string; projectId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const orchestrator = useRoleSession("orchestrator", null);
  const pm = useRoleSession("pm", params.projectId ?? null);
  if (params.sessionId) return params.sessionId;
  if (pathname === "/") return orchestrator?.id;
  if (params.projectId && pathname.endsWith("/pm")) return pm?.id;
  return undefined;
}

/** Send a fresh install to the first-run checklist (§14) once, from the home route. */
function useFirstRunRedirect() {
  const { data } = useSnapshot();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pending = data ? !data.settings.setup.completed : false;
  useEffect(() => {
    if (pending && pathname === "/") void navigate({ to: "/setup" });
  }, [pending, pathname, navigate]);
}

/**
 * Sidebar · centre · right panel, with resizable dividers and an optional terminal drawer
 * (§13). On phones and portrait tablets the sidebar is a drawer and the right panel a
 * full-screen sheet; touch tablets in landscape keep the icon rail and an overlay panel.
 */
export function AppShell() {
  const layout = useLayoutStore();
  const viewport = useViewport();
  const setNavOpen = useUiStore((s) => s.setNavOpen);
  const sessionId = useCurrentSessionId();
  // The workbench panel belongs to sessions that own a worktree.
  const hasWorkbench = Boolean(useSession(sessionId)?.worktreePath);
  useGlobalShortcuts();
  useFirstRunRedirect();
  const inlineSidebar = !viewport.drawerNav;
  const collapsed = viewport.railNav || layout.sidebarCollapsed;
  const panel = sessionId && hasWorkbench ? sessionId : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {inlineSidebar &&
        (collapsed ? (
          <SidebarRail onExpand={viewport.railNav ? () => setNavOpen(true) : undefined} />
        ) : (
          <Sidebar width={layout.sidebarWidth} />
        ))}
      {!inlineSidebar ? null : !collapsed ? (
        <ResizeHandle
          label="Resize sidebar"
          value={layout.sidebarWidth}
          direction={1}
          onResize={layout.setSidebarWidth}
          onReset={() => layout.setSidebarWidth(SIDEBAR.default)}
          className="bg-sidebar-border"
        />
      ) : (
        <div className="w-px shrink-0 bg-sidebar-border" />
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
        {layout.drawerOpen && !viewport.phone && (
          <>
            <ResizeHandle
              orientation="horizontal"
              label="Resize terminal"
              value={layout.drawerHeight}
              direction={-1}
              onResize={layout.setDrawerHeight}
              onReset={() => layout.setDrawerHeight(DRAWER.default)}
            />
            <div style={{ height: layout.drawerHeight }} className="shrink-0">
              <TerminalDrawer sessionId={sessionId ?? null} />
            </div>
          </>
        )}
      </main>

      {panel && viewport.sheetPanels && (
        <Sheet open={layout.rightSheetOpen} onOpenChange={(open) => layout.toggleRight(open)}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none md:data-[side=right]:w-[min(42rem,85vw)]"
            data-testid="right-sheet"
          >
            <SheetTitle className="sr-only">Session panel</SheetTitle>
            <SheetDescription className="sr-only">Diff, files, browser and more</SheetDescription>
            <RightPanel sessionId={panel} width="100%" />
          </SheetContent>
        </Sheet>
      )}
      {panel && !viewport.sheetPanels && layout.rightOpen && (
        <>
          <ResizeHandle
            label="Resize panel"
            value={layout.rightWidth}
            direction={-1}
            onResize={layout.setRightWidth}
            onReset={() => layout.setRightWidth(RIGHT.default)}
          />
          <RightPanel sessionId={panel} width={layout.rightWidth} />
        </>
      )}

      {(viewport.drawerNav || viewport.railNav) && <MobileNavDrawer />}
      <CommandPalette />
      <AddProjectDialog />
      <HandoffDialog />
      <ShortcutsDialog />
      <LiveEffects />
    </div>
  );
}
