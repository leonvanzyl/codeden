import { create } from "zustand";
import type { PrAsk } from "@/lib/pull-request";

interface PrRequestsState {
  /**
   * Requests for a pull request made from this window, by session: they bridge the moment
   * between the press and the server showing the request (queued, or the turn carrying it).
   * After that, and after a reload, the queue and the transcript say where it stands.
   */
  asked: Record<string, PrAsk>;
  ask: (sessionId: string, ask: PrAsk) => void;
  /** The request failed, or its queued message was deleted or dropped. */
  forget: (sessionId: string) => void;
}

/** Requests for a pull request in progress (Git bar, Issue / PR tab, Push toast). Not persisted. */
export const usePrRequestsStore = create<PrRequestsState>()((set) => ({
  asked: {},
  ask: (sessionId, ask) => set((s) => ({ asked: { ...s.asked, [sessionId]: ask } })),
  forget: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.asked)) return s;
      const { [sessionId]: _, ...rest } = s.asked;
      return { asked: rest };
    }),
}));
