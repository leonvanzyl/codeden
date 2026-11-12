import type { Session, UserInputInit } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp, ListPlus, Square, Zap } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type SendMode, useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";
import { sendToSession } from "@/lib/send-to-session";
import { matchesCombo, shortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { getDraft, useComposerStore } from "@/stores/composer";
import { toInputAttachments } from "./attachments";
import { ComposerBox, canSendDraft, composerPlaceholders, isSendKey } from "./composer-box";
import { SessionOptions } from "./session-options";
import { SuggestionMenu } from "./suggestion-menu";
import { applyTrigger } from "./trigger";
import { type SuggestionSource, useSuggestions } from "./use-suggestions";

/**
 * The composer (§13): text, attachments, `@` mentions, `/` commands, the options slot (pickers),
 * queue or steer and stop while a turn runs, dictation and the send keys. The same component
 * serves a session (`SessionComposer`) and the New session draft, where nothing runs yet; the
 * draft lives in the composer store under `draftKey`, and `onSend` decides what sending does.
 */
export function Composer({
  draftKey,
  source,
  placeholder,
  options,
  running = false,
  canSteer = false,
  sending,
  onSend,
  onStop,
}: {
  draftKey: string;
  /** Where `@` and `/` suggestions come from. */
  source: SuggestionSource;
  placeholder: string;
  /** Pickers after the attach button. */
  options: ReactNode;
  /** A turn is running: sending queues or steers, and an empty composer offers Stop. */
  running?: boolean;
  /** The provider can steer a running turn. */
  canSteer?: boolean;
  /** A send is in flight: the send button waits (Enter still calls `onSend`). */
  sending: boolean;
  onSend: (input: UserInputInit, mode: SendMode) => void;
  onStop?: () => void;
}) {
  const draft = useComposerStore((s) => getDraft(s, draftKey));
  const { setText } = useComposerStore.getState();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [mode, setMode] = useState<Exclude<SendMode, "send">>("queue");
  const suggestions = useSuggestions(source, draft.text, caret);

  const canSend = canSendDraft(draft);
  const submit = (override?: SendMode) => {
    if (!canSend) return;
    onSend(
      { text: draft.text.trim(), attachments: toInputAttachments(draft.attachments) },
      override ?? (running ? (canSteer ? mode : "queue") : "send"),
    );
  };

  const pick = (insert: string) => {
    if (!suggestions.trigger) return;
    const next = applyTrigger(draft.text, caret, suggestions.trigger, insert);
    setText(draftKey, next.text);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.open && suggestions.items.length > 0) {
      const n = suggestions.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggestions.setActive((suggestions.active + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        suggestions.setActive((suggestions.active - 1 + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const s = suggestions.items[suggestions.active];
        if (s) pick(s.insert);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        suggestions.dismiss();
        return;
      }
    }
    if (matchesCombo(e.nativeEvent, shortcut("stop").combo) && running && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    if (isSendKey(e)) {
      e.preventDefault();
      submit(running && canSteer && (e.ctrlKey || e.metaKey) ? "steer" : undefined);
    }
  };

  return (
    <ComposerBox
      draftKey={draftKey}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onCaret={setCaret}
      textareaRef={ref}
      menu={
        suggestions.open && (
          <SuggestionMenu
            title={suggestions.title}
            items={suggestions.items}
            active={suggestions.active}
            onHover={suggestions.setActive}
            onPick={(s) => pick(s.insert)}
          />
        )
      }
      options={options}
      actions={
        running &&
        canSteer && (
          <div
            className="mr-1 flex h-7 items-center rounded-lg border border-border p-0.5 text-2xs pointer-coarse:h-10"
            title="While a turn runs"
          >
            {(["queue", "steer"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "flex h-full items-center gap-1 rounded-md px-2 capitalize text-muted-foreground transition-colors",
                  mode === m && "bg-accent text-foreground",
                )}
              >
                {m === "queue" ? <ListPlus className="size-3" /> : <Zap className="size-3" />}
                {m}
              </button>
            ))}
          </div>
        )
      }
    >
      {running && !canSend && onStop ? (
        <Button
          size="icon-sm"
          variant="secondary"
          className="rounded-full"
          onClick={onStop}
          aria-label="Stop"
        >
          <Square className="size-3 fill-current" />
        </Button>
      ) : (
        <Button
          size="icon-sm"
          className="rounded-full transition-transform hover:scale-105"
          onClick={() => submit()}
          disabled={!canSend || sending}
          aria-label={running ? (canSteer ? `${mode} message` : "Queue message") : "Send"}
        >
          {running ? mode === "steer" && canSteer ? <Zap /> : <ListPlus /> : <ArrowUp />}
        </Button>
      )}
    </ComposerBox>
  );
}

/** The composer of a session: sends, queues or steers, stops a turn, and edits its options. */
export function SessionComposer({ session, running }: { session: Session; running: boolean }) {
  const client = useClient();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const { setText, clear } = useComposerStore.getState();
  const provider = providers.find((p) => p.id === session.provider);

  // The input is captured at submit time: `onMutate` clears the draft before `mutationFn` runs.
  const send = useMutation({
    mutationFn: ({ sendMode, input }: { sendMode: SendMode; input: UserInputInit }) =>
      sendToSession(client, session, input, sendMode),
    onMutate: () => clear(session.id),
    onSuccess: (_d, { sendMode }) => {
      // Queued messages show in the tray above the composer.
      if (sendMode === "steer") toast("Sent to the running turn");
    },
    onError: (e, { input }) => {
      setText(session.id, input.text);
      toast.error("Message not sent", { description: e.message });
    },
  });
  const stop = useMutation({ mutationFn: () => client.interrupt(session.id) });

  return (
    <Composer
      draftKey={session.id}
      source={{ kind: "session", sessionId: session.id }}
      placeholder={
        running
          ? "Queue a follow-up, or steer the running turn…"
          : composerPlaceholders[session.role]
      }
      options={<SessionOptions session={session} running={running} />}
      running={running}
      canSteer={provider?.capabilities.steer ?? false}
      sending={send.isPending}
      onSend={(input, sendMode) => send.mutate({ sendMode, input })}
      onStop={() => stop.mutate()}
    />
  );
}
