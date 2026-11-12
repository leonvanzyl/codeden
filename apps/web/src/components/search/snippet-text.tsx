import type { SnippetPart } from "@codeden/contracts";
import { cn } from "@/lib/utils";

/** A search snippet with its matches highlighted. Plain text only: parts are never HTML. */
export function SnippetText({ parts, className }: { parts: SnippetPart[]; className?: string }) {
  return (
    <span className={cn("min-w-0", className)}>
      {parts.map((part, i) =>
        part.match ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are static text in order.
            key={i}
            className="rounded-[3px] bg-primary/15 px-px text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are static text in order.
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
