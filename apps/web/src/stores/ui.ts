import { create } from "zustand";
import type { ComposerBounds } from "@/lib/toast-placement";

interface UiState {
  paletteOpen: boolean;
  addProjectOpen: boolean;
  shortcutsOpen: boolean;
  /** The sidebar drawer on phones and tablets. */
  navOpen: boolean;
  /** A native browser view is on screen (toasts move away from it). */
  nativeBrowserShown: boolean;
  /** Where the composer on screen is (toasts are lifted clear of it), or null without one. */
  composerBounds: ComposerBounds | null;
  setPaletteOpen: (open: boolean) => void;
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
  addProjectOpen: false,
  shortcutsOpen: false,
  navOpen: false,
  nativeBrowserShown: false,
  composerBounds: null,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setNavOpen: (navOpen) => set({ navOpen }),
  setNativeBrowserShown: (nativeBrowserShown) => set({ nativeBrowserShown }),
  setComposerBounds: (composerBounds) => {
    if (!sameBounds(get().composerBounds, composerBounds)) set({ composerBounds });
  },
}));
