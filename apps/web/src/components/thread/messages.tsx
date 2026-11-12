import { type Attachment, type ItemOf, splitSender } from "@codeden/contracts";
import { Copy, FileText } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { ImageGallery, ImageThumbnail } from "@/components/common/image-viewer";
import { useClient } from "@/lib/api";
import { attachmentGallery } from "@/lib/attachments";
import { foldDigest } from "@/lib/orchestration";
import { platform } from "@/lib/platform";
import { DigestDisclosure, WakeLine } from "./digest-fold";
import { Markdown } from "./markdown";
import { SenderMessage } from "./sender-message";

/** A file (or an image shown by name): long names are cut with an ellipsis, full on hover. */
function FileChip({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 font-mono text-2xs text-muted-foreground"
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * One attachment: an image opens in the viewer (`image` is its place in the message's
 * gallery, `-1` when it can't be shown); anything else is a chip with its name.
 */
function AttachmentView({
  attachment,
  image,
  src,
}: {
  attachment: Attachment;
  image: number;
  src: string | undefined;
}) {
  if (attachment.type === "file") return <FileChip label={attachment.name ?? attachment.path} />;
  // Images are served from artifacts; the browser never loads a filesystem path. A path the
  // server could not map to an artifact arrives as a bare file name.
  if (image < 0 || !src) {
    const label = attachment.source.type === "path" ? attachment.source.path : "image";
    return <FileChip label={attachment.name ?? label} />;
  }
  return (
    <ImageThumbnail index={image} className="block overflow-hidden rounded-lg border border-border">
      <img
        src={src}
        alt={attachment.name ?? "Attached image"}
        className="h-28 w-auto max-w-64 object-cover"
      />
    </ImageThumbnail>
  );
}

function Attachments({ id, attachments }: { id: string; attachments: Attachment[] }) {
  const client = useClient();
  const { images, positions } = useMemo(
    () => attachmentGallery(attachments, client.artifactUrl),
    [attachments, client],
  );
  return (
    <ImageGallery images={images}>
      <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
        {attachments.map((a, i) => {
          const image = positions[i] ?? -1;
          return (
            <AttachmentView
              // biome-ignore lint/suspicious/noArrayIndexKey: attachments have no ids and never reorder.
              key={`${id}-${i}`}
              attachment={a}
              image={image}
              src={images[image]?.src}
            />
          );
        })}
      </div>
    </ImageGallery>
  );
}

/**
 * User message: a soft right-aligned bubble with attachments above the text. The status digest
 * CodeDen adds for role sessions is folded away; automatic wake-ups become a quiet divider.
 * A message from anyone else (a PM, the orchestrator, the factory, an automation, CodeDen),
 * a session's opening brief included, becomes a Markdown card headed by its sender. The user's
 * own text stays plain, exactly as typed.
 */
export function UserMessage({ item }: { item: ItemOf<"user_message"> }) {
  const { attachments, from: recorded } = item.input;
  const folded = useMemo(() => foldDigest(item.input.text), [item.input.text]);
  const sender = useMemo(() => splitSender(folded.text, recorded), [folded.text, recorded]);
  if (folded.wake && attachments.length === 0) return <WakeLine folded={folded} />;
  const from = sender.from === "user" ? null : sender.from;
  const text = folded.text;
  return (
    <div className="group flex flex-col items-end gap-1.5 animate-rise">
      <DigestDisclosure folded={folded} />
      {attachments.length > 0 && <Attachments id={item.id} attachments={attachments} />}
      {from ? (
        <SenderMessage from={from} text={sender.text} />
      ) : (
        text && (
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-message px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
            {text}
          </div>
        )
      )}
    </div>
  );
}

/** Assistant message: plain markdown, no bubble, with a hover copy action. */
export function AssistantMessage({
  item,
  streaming,
}: {
  item: ItemOf<"assistant_message">;
  streaming: boolean;
}) {
  return (
    <div className="group relative">
      <Markdown streaming={streaming}>{item.text}</Markdown>
      {!streaming && item.text && (
        <button
          type="button"
          className="absolute -bottom-5 left-0 flex items-center gap-1 text-3xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground touch:opacity-100"
          onClick={() => {
            void platform.writeClipboard(item.text);
            toast.success("Copied message");
          }}
        >
          <Copy className="size-3" /> Copy
        </button>
      )}
    </div>
  );
}
