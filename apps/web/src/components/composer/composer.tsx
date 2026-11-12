import type { Session, UserInputInit } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp, ListPlus, Square, Zap } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
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
import { useSuggestions } from "./use-suggestions";

/** Composer (§13): text, attachments, mentions, commands, pickers, queue/steer, stop, voice. */
export function Composer({ session, running }: { session: Session; running: boolean }) {
  const client = useClient();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const draft = useComposerStore((s) => getDraft(s, session.id));
  const { setText, clear } = useComposerStore.getState();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [mode, setMode] = useState<Exclude<SendMode, "send">>("queue");

  const provider = providers.find((p) => p.id === session.provider);
  const canSteer = provider?.capabilities.steer ?? false;
  const suggestions = useSuggestions(session.id, draft.text, caret);

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

  const canSend = canSendDraft(draft);
  const submit = (override?: SendMode) => {
    if (!canSend) return;
    send.mutate({
      sendMode: override ?? (running ? (canSteer ? mode : "queue") : "send"),
      input: { text: draft.text.trim(), attachments: toInputAttachments(draft.attachments) },
    });
  };

  const pick = (insert: string) => {
    if (!suggestions.trigger) return;
    const next = applyTrigger(draft.text, caret, suggestions.trigger, insert);
    setText(session.id, next.text);
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
    if (matchesCombo(e.nativeEvent, shortcut("stop").combo) && running) {
      e.preventDefault();
      stop.mutate();
      return;
    }
    if (isSendKey(e)) {
      e.preventDefault();
      submit(running && canSteer && (e.ctrlKey || e.metaKey) ? "steer" : undefined);
    }
  };

  return (
    <ComposerBox
      draftKey={session.id}
      placeholder={
        running
          ? "Queue a follow-up, or steer the running turn…"
          : composerPlaceholders[session.role]
      }
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
      options={<SessionOptions session={session} running={running} />}
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
      {running && !canSend ? (
        <Button
          size="icon-sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => stop.mutate()}
          aria-label="Stop"
        >
          <Square className="size-3 fill-current" />
        </Button>
      ) : (
        <Button
          size="icon-sm"
          className="rounded-full transition-transform hover:scale-105"
          onClick={() => submit()}
          disabled={!canSend || send.isPending}
          aria-label={running ? (canSteer ? `${mode} message` : "Queue message") : "Send"}
        >
          {running ? mode === "steer" && canSteer ? <Zap /> : <ListPlus /> : <ArrowUp />}
        </Button>
      )}
    </ComposerBox>
  );
}
