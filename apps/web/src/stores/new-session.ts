import type { UserInputInit } from "@codeden/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type DraftChoice, emptyChoice } from "@/lib/new-session";

/** A project's New session draft besides its text: the options picked and the work key. */
export interface NewSessionDraft {
  choice: DraftChoice;
  /** Optional §8.4 work key; sessions with the same key are flagged as duplicates. */
  workKey: string;
}

export const emptyNewSessionDraft: NewSessionDraft = { choice: emptyChoice, workKey: "" };

interface NewSessionState {
  /** By project id. Kept in the browser (localStorage), never on the server. */
  drafts: Record<string, NewSessionDraft>;
  /**
   * The first message of a session started from a draft, by session id, until its transcript
   * shows it: the session view shows it straight away while the worktree is prepared. In memory
   * only.
   */
  firstMessages: Record<string, UserInputInit>;
  setChoice: (projectId: string, choice: Partial<DraftChoice>) => void;
  setWorkKey: (projectId: string, workKey: string) => void;
  /** Forget a project's draft options and work key (after its session started). */
  reset: (projectId: string) => void;
  setFirstMessage: (sessionId: string, input: UserInputInit) => void;
}

export function getNewSessionDraft(
  state: Pick<NewSessionState, "drafts">,
  projectId: string,
): NewSessionDraft {
  return state.drafts[projectId] ?? emptyNewSessionDraft;
}

/** The New session drafts' options and work keys, and the first messages they sent. */
export const useNewSessionStore = create<NewSessionState>()(
  persist(
    (set) => ({
      drafts: {},
      firstMessages: {},
      setChoice: (projectId, choice) =>
        set((s) => {
          const d = getNewSessionDraft(s, projectId);
          return {
            drafts: { ...s.drafts, [projectId]: { ...d, choice: { ...d.choice, ...choice } } },
          };
        }),
      setWorkKey: (projectId, workKey) =>
        set((s) => ({
          drafts: { ...s.drafts, [projectId]: { ...getNewSessionDraft(s, projectId), workKey } },
        })),
      reset: (projectId) =>
        set((s) => {
          const { [projectId]: _gone, ...rest } = s.drafts;
          return { drafts: rest };
        }),
      setFirstMessage: (sessionId, input) =>
        set((s) => ({ firstMessages: { ...s.firstMessages, [sessionId]: input } })),
    }),
    { name: "codeden.new-session", partialize: ({ drafts }) => ({ drafts }) },
  ),
);
