/**
 * Types the web client needs that are not in `@codeden/contracts`: UI-only shapes (file tree
 * nodes, live channels).
 * Server shapes come from contracts.
 */

// ------------------------------------------------------------------ workbench (§12)

/** A node of the files panel tree, built from `SessionFileList` entries. */
export interface FileNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: FileNode[];
  /** Git status in the worktree. */
  status?: "added" | "modified" | "deleted";
}

export interface MentionCandidate {
  path: string;
  kind: "file" | "dir";
}

// ------------------------------------------------------------------ live workbench channels

/** Lifecycle of a terminal channel (`/ws/pty` control frames). */
export type TerminalEvent =
  | { type: "opened"; ptyId: string; attached: boolean }
  | { type: "exited"; exitCode: number | null }
  | { type: "error"; message: string };

export interface TerminalChannel {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): () => void;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
  /** Detach (the terminal keeps running in the runner). */
  close(): void;
  /** End the terminal process. */
  kill(): void;
}

export interface OpenTerminalOptions {
  sessionId: string | null;
  /** Typed into the shell once it starts (e.g. `claude auth login`). */
  command?: string;
  /** Re-attach to a terminal opened earlier instead of starting a new one. */
  ptyId?: string;
}
