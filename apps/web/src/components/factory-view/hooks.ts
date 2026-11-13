import { useEffect, useState, useSyncExternalStore } from "react";

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

/**
 * True at `lg` (1024 px) and wider: the stages sit side by side. Below it they stack and the
 * chat opens as a bottom sheet.
 */
export function useWide(): boolean {
  return useMedia("(min-width: 1024px)", true);
}

/**
 * True at `xl` (1280 px) and wider: the PM chat can sit beside the pipeline as a column and the
 * six stages keep cards wide enough to read. Narrower, it opens as a sheet.
 */
export function useChatColumn(): boolean {
  return useMedia("(min-width: 1280px)", true);
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
