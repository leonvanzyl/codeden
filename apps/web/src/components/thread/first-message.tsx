import { type Session, UserInput, type UserInputInit } from "@codeden/contracts";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { UserMessage } from "./messages";

/**
 * The first message of a session started from the New session draft, shown the moment the
 * draft becomes the session and laid out as the transcript lays it out, while the worktree is
 * prepared and the turn starts. The transcript's own turn replaces it.
 */
export function FirstMessage({
  input,
  status,
}: {
  input: UserInputInit;
  /** The session's status: a note says what it waits for while it is starting or queued. */
  status: Session["status"];
}) {
  const note =
    status === "starting"
      ? "Starting the session…"
      : status === "queued"
        ? "Queued behind running work…"
        : null;
  const item = useMemo(
    () => ({
      id: "first-message",
      kind: "user_message" as const,
      status: "completed" as const,
      input: UserInput.parse(input),
    }),
    [input],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin [scrollbar-gutter:stable]">
      <div
        className="mx-auto w-full max-w-[46rem] space-y-4 px-6 pt-6 pb-4 wrap-break-word"
        data-testid="first-message"
      >
        <UserMessage item={item} />
        {note && (
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {note}
          </p>
        )}
      </div>
    </div>
  );
}
