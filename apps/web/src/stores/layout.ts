import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightTab = "diff" | "files" | "browser" | "terminal" | "github" | "details" | "thread";

export const SIDEBAR = { min: 220, max: 420, default: 268, rail: 56 } as const;
export const RIGHT = { min: 340, max: 900, default: 460 } as const;
export const DRAWER = { min: 140, max: 600, default: 260 } as const;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  rightOpen: boolean;
  /**
   * The right panel as an overlay sheet (phones and tablets). Not persisted, so a phone
   * never opens on a sheet covering the transcript.
   */
  rightSheetOpen: boolean;
  rightWidth: number;
  rightTab: RightTab;
  /**
   * Subagent thread shown in the right panel's Thread tab; `focusItemId` (a search hit) opens
   * it at that item instead of the end.
   */
  childThread: { sessionId: string; threadId: string; focusItemId?: string } | null;
  drawerOpen: boolean;
  drawerHeight: number;
  expandedProjects: Record<string, boolean>;
  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setRightWidth: (w: number) => void;
  toggleRight: (open?: boolean) => void;
  openRightTab: (tab: RightTab) => void;
  openChildThread: (sessionId: string, threadId: string, focusItemId?: string) => void;
  setDrawerHeight: (h: number) => void;
  toggleDrawer: (open?: boolean) => void;
  toggleProject: (id: string, open?: boolean) => void;
}

/** Shell layout: panel sizes, open state and tabs. Persisted per browser. */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR.default,
      sidebarCollapsed: false,
      rightOpen: true,
      rightSheetOpen: false,
      rightWidth: RIGHT.default,
      rightTab: "diff",
      childThread: null,
      drawerOpen: false,
      drawerHeight: DRAWER.default,
      expandedProjects: { "p-storefront": true, "p-billing": true },
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR.min, SIDEBAR.max) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setRightWidth: (w) => set({ rightWidth: clamp(w, RIGHT.min, RIGHT.max) }),
      toggleRight: (open) =>
        set((s) => {
          const next = open ?? !s.rightOpen;
          return { rightOpen: next, rightSheetOpen: next };
        }),
      openRightTab: (tab) => set({ rightTab: tab, rightOpen: true, rightSheetOpen: true }),
      openChildThread: (sessionId, threadId, focusItemId) =>
        set({
          childThread: { sessionId, threadId, ...(focusItemId ? { focusItemId } : {}) },
          rightTab: "thread",
          rightOpen: true,
          rightSheetOpen: true,
        }),
      setDrawerHeight: (h) => set({ drawerHeight: clamp(h, DRAWER.min, DRAWER.max) }),
      toggleDrawer: (open) => set((s) => ({ drawerOpen: open ?? !s.drawerOpen })),
      toggleProject: (id, open) =>
        set((s) => ({
          expandedProjects: { ...s.expandedProjects, [id]: open ?? !s.expandedProjects[id] },
        })),
    }),
    {
      name: "codeden.layout",
      partialize: ({ childThread: _c, rightSheetOpen: _s, ...rest }) => rest,
    },
  ),
);
