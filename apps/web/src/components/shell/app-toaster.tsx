import { Toaster } from "@/components/ui/sonner";
import { toasterOffsets } from "@/lib/toast-placement";
import { useUiStore } from "@/stores/ui";

/**
 * The app's toasts: bottom-right, at most three on screen (bursts of updates are grouped into
 * one before that). A native browser view paints over the page, toasts included, so they move
 * to the bottom-left while one is shown. Where they would cover the composer (always on phones,
 * where they are full width), they sit just above it instead.
 */
export function AppToaster() {
  const nativeShown = useUiStore((s) => s.nativeBrowserShown);
  const composer = useUiStore((s) => s.composerBounds);
  const side = nativeShown ? "left" : "right";
  return (
    <Toaster position={`bottom-${side}`} visibleToasts={3} {...toasterOffsets(composer, side)} />
  );
}
