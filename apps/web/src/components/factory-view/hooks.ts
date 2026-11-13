import { useEffect, useState, useSyncExternalStore } from "react";

const WIDE = "(min-width: 1024px)";

/**
 * True at `lg` and wider: the stages sit side by side and the PM chat is a column. Below it
 * the stages stack and the chat opens as a bottom sheet.
 */
export function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(WIDE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * The time, refreshed every `everyMs`, for "in this step for 12m" labels. A render clock
 * only: the data itself arrives over the WebSocket.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
