import { type RefObject, useEffect } from "react";
import type { ToasterProps } from "sonner";
import { useUiStore } from "@/stores/ui";

/** Where the composer's box is on screen, in viewport pixels, with the viewport it was measured in. */
export interface ComposerBounds {
  top: number;
  left: number;
  right: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Where the toaster draws toasts (its defaults): a 356 px column 24 px in from the corner, or
// full width 16 px from the edges on narrow screens (at 600 px and below, decided by its CSS).
const TOAST_WIDTH = 356;
const OFFSET = 24;
const MOBILE_OFFSET = 16;
/** Space between a lifted toast and the top of the composer. */
const GAP = 8;

/**
 * The toaster's bottom offsets that keep toasts clear of the composer (§13), for toasts in the
 * bottom corner on `side`. Narrow screens show toasts full width, so they always sit above the
 * composer. Wider ones lift them only when the toast column would overlap the composer, so a
 * composer beside the column (a wide desktop window) leaves toasts in the corner. Without a
 * composer on screen, toasts keep the default offsets.
 */
export function toasterOffsets(
  composer: ComposerBounds | null,
  side: "left" | "right",
): Pick<ToasterProps, "offset" | "mobileOffset"> {
  if (!composer) return {};
  const lifted = Math.max(0, composer.viewportHeight - composer.top) + GAP;
  const columnLeft = side === "right" ? composer.viewportWidth - OFFSET - TOAST_WIDTH : OFFSET;
  const beside = composer.right <= columnLeft || composer.left >= columnLeft + TOAST_WIDTH;
  return {
    mobileOffset: { bottom: Math.max(MOBILE_OFFSET, lifted) },
    ...(beside ? {} : { offset: { bottom: Math.max(OFFSET, lifted) } }),
  };
}

function measure(box: HTMLElement): ComposerBounds | null {
  const r = box.getBoundingClientRect();
  // A hidden composer (no layout box) is not on screen.
  if (r.width === 0 || r.height === 0) return null;
  return {
    top: Math.round(r.top),
    left: Math.round(r.left),
    right: Math.round(r.right),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

/**
 * Publish where the composer's `box` is, so the toaster can keep toasts off it. Measured again
 * whenever the box or its column changes size (a longer message, attachments, an opened panel)
 * and when the window resizes. Cleared when the composer goes away.
 */
export function useComposerBounds(
  box: RefObject<HTMLElement | null>,
  column: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { setComposerBounds } = useUiStore.getState();
    const publish = () => setComposerBounds(measure(el));
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    if (column.current) observer.observe(column.current);
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      setComposerBounds(null);
    };
  }, [box, column]);
}
