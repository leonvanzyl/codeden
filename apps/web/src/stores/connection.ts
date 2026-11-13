import type { RunnerConnectionStatus, RunnerRecord } from "@codeden/contracts";
import { create } from "zustand";

export type SocketState = "connecting" | "open" | "closed";
export type AuthState = "unknown" | "ok" | "unauthorized" | "signin";

interface ConnectionState {
  socket: SocketState;
  /**
   * `unauthorized` after a 401: the browser has no valid CodeDen cookie. `signin`: a remote
   * device (network access, §15.1) that has to sign in with the password.
   */
  auth: AuthState;
  /** Highest event seq applied by this client. */
  seq: number;
  /** The home runner's connection: what the shell shows. */
  runner: RunnerConnectionStatus | null;
  /** Every runner the server drives, the home runner first, with its live state. */
  runners: RunnerRecord[];
  setSocket: (socket: SocketState) => void;
  setAuth: (auth: AuthState) => void;
  setSeq: (seq: number) => void;
  /** The home runner's status and, from servers that send it, the list of runners. */
  setRunner: (runner: RunnerConnectionStatus, runners?: RunnerRecord[]) => void;
}

/** Live connection state fed by the realtime WebSocket. */
export const useConnectionStore = create<ConnectionState>()((set) => ({
  socket: "connecting",
  auth: "unknown",
  seq: 0,
  runner: null,
  runners: [],
  setSocket: (socket) => set({ socket }),
  setAuth: (auth) => set({ auth }),
  setSeq: (seq) => set({ seq }),
  setRunner: (runner, runners) => set(runners ? { runner, runners } : { runner }),
}));
