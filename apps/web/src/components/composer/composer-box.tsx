import type { Session, UserInputInit } from "@codeden/contracts";
import { Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSnapshotData } from "@/lib/queries";
import { useComposerBounds } from "@/lib/toast-placement";
import { cn } from "@/lib/utils";
import { type Draft, getDraft, useComposerStore } from "@/stores/composer";
import { AttachmentStrip, filesToAttachments, toInputAttachments } from "./attachments";
import { VoiceButton } from "./voice-button";

export const composerPlaceholders: Record<Session["role"], string> = {
  orchestrator: "Ask the orchestrator to start a project, triage issues or check on work…",
  pm: "Message the project manager…",
  agent: "Message the agent — @ to mention files, / for commands and skills",
};

/** A draft can be sent with text, attachments or both. */
export const canSendDraft = (draft: Draft) =>
  draft.text.trim().length > 0 || draft.attachments.length > 0;

/** What sending the draft sends. */
export const draftInput = (draft: Draft): UserInputInit => ({
  text: draft.text.trim(),
  attachments: toInputAttachments(draft.attachments),
});

/** Enter sends; Shift+Enter and IME composition keep typing. */
export const isSendKey = (e: KeyboardEvent<HTMLTextAreaElement>) =>
  e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;

/**
 * The composer's input box (§13), shared by session composers and the composer of a role
 * session that does not exist yet: text, image and file paste, drag-and-drop and the attach
 * button, the attachment strip and dictation (button and shortcuts, in the dictation language
 * from Settings). The draft lives in the composer store under `draftKey`; callers add their
 * own controls and handle keys, including Enter to send.
 */
export function ComposerBox({
  draftKey,
  placeholder,
  onKeyDown,
  onCaret,
  textareaRef,
  combobox,
  menu,
  options,
  actions,
  children,
}: {
  draftKey: string;
  placeholder: string;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Gets the caret position whenever the text or selection changes. */
  onCaret?: (caret: number) => void;
  /** The textarea, for callers that move the caret. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /**
   * Makes the box a combobox for a suggestion list in `menu`, so screen readers hear the list
   * open and close and the highlighted option: the listbox's id, whether it is open, and the
   * highlighted option's id (none when the list is empty).
   */
  combobox?: { listId: string; open: boolean; activeId?: string };
  /** Floating content above the box, such as the suggestion menu. */
  menu?: ReactNode;
  /** Controls after the attach button. */
  options?: ReactNode;
  /** Controls before the dictation button. */
  actions?: ReactNode;
  /** The send control, after the dictation button. */
  children: ReactNode;
}) {
  const draft = useComposerStore((s) => getDraft(s, draftKey));
  const focusToken = useComposerStore((s) => s.focusToken);
  const { setText, addAttachments, removeAttachment } = useComposerStore.getState();
  const dictationLanguage = useSnapshotData((s) => s.settings.voice.dictation.language, null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Toasts are lifted clear of the box (its Send, Stop and pickers) wherever they would cover it.
  useComposerBounds(box);

  useEffect(() => {
    if (focusToken > 0) {
      ref.current?.focus();
      const end = ref.current?.value.length ?? 0;
      ref.current?.setSelectionRange(end, end);
    }
  }, [focusToken, ref]);

  const attach = async (files: File[]) => {
    if (files.length > 0) addAttachments(draftKey, await filesToAttachments(files));
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void attach(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="mx-auto w-full max-w-[46rem] px-3 pb-3 sm:px-6 sm:pb-5">
      <div className="relative">
        {menu}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for files; the textarea and attach button stay keyboard accessible. */}
        <div
          ref={box}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-2xl border border-border bg-card shadow-[0_10px_30px_-18px] shadow-black/40 transition-[border-color,box-shadow] focus-within:border-primary/35 focus-within:shadow-[0_0_0_4px] focus-within:shadow-primary/[0.07]",
            dragging && "border-dashed border-primary/60 bg-primary/[0.03]",
          )}
        >
          <AttachmentStrip
            items={draft.attachments}
            onRemove={(id) => removeAttachment(draftKey, id)}
          />
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-expanded is only set with role="combobox", which supports it; the rule reads the textarea's implicit textbox role. */}
          <textarea
            ref={ref}
            value={draft.text}
            rows={1}
            onChange={(e) => {
              setText(draftKey, e.target.value);
              onCaret?.(e.target.selectionStart);
            }}
            onSelect={(e) => onCaret?.(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            aria-label="Message"
            role={combobox ? "combobox" : undefined}
            aria-autocomplete={combobox ? "list" : undefined}
            aria-expanded={combobox ? combobox.open : undefined}
            aria-controls={combobox?.open ? combobox.listId : undefined}
            aria-activedescendant={combobox?.open ? combobox.activeId : undefined}
            className="block max-h-64 min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
          />
          <div className="flex flex-wrap items-center gap-0.5 gap-y-1 px-2 pb-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => void attach(Array.from(e.target.files ?? []))}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => fileInput.current?.click()}
                  aria-label="Attach files"
                >
                  <Paperclip />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach files or paste an image</TooltipContent>
            </Tooltip>
            {options}
            <div className="ml-auto flex items-center gap-1">
              {actions}
              <VoiceButton
                baseText={draft.text}
                onText={(t) => setText(draftKey, t)}
                language={dictationLanguage}
              />
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
