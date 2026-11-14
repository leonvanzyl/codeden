import { create } from "zustand";
import type { ComposerBounds } from "@/lib/toast-placement";

/** The handoff dialog (§9): the session to hand off and, when chosen already, the provider. */
export interface HandoffTarget {
  sessionId: string;
  provider: string | null;
}

interface UiState {
  paletteOpen: boolean;
  /** The open handoff dialog, or null. */
  handoff: HandoffTarget | null;
  addProjectOpen: boolean;
  shortcutsOpen: boolean;
  /** The sidebar drawer on phones and tablets. */
  navOpen: boolean;
  /** A native browser view is on screen (toasts move away from it). */
  nativeBrowserShown: boolean;
  /** Where the composer on screen is (toasts are lifted clear of it), or null without one. */
  composerBounds: ComposerBounds | null;
  setPaletteOpen: (open: boolean) => void;
  /** Open the handoff dialog for a session, optionally with a provider chosen; null closes it. */
  setHandoff: (target: HandoffTarget | null) => void;
  setAddProjectOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setNavOpen: (open: boolean) => void;
  setNativeBrowserShown: (shown: boolean) => void;
  setComposerBounds: (bounds: ComposerBounds | null) => void;
}

const sameBounds = (a: ComposerBounds | null, b: ComposerBounds | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.right === b.right &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight);

/** Transient UI state (dialogs, palette). Not persisted. */
export const useUiStore = create<UiState>()((set, get) => ({
  paletteOpen: false,
  handoff: null,
  addProjectOpen: false,
  shortcutsOpen: false,
  navOpen: false,
  nativeBrowserShown: false,
  composerBounds: null,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setHandoff: (handoff) => set({ handoff }),
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setNavOpen: (navOpen) => set({ navOpen }),
  setNativeBrowserShown: (nativeBrowserShown) => set({ nativeBrowserShown }),
  setComposerBounds: (composerBounds) => {
    if (!sameBounds(get().composerBounds, composerBounds)) set({ composerBounds });
  },
}));
