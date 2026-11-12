import { File, Folder, Sparkles, SquareSlash } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface Suggestion {
  id: string;
  label: string;
  description?: string;
  icon: "file" | "dir" | "command" | "skill";
  /** Text inserted in place of the trigger. */
  insert: string;
}

const icons = { file: File, dir: Folder, command: SquareSlash, skill: Sparkles };

/** Floating list above the composer for `@` mentions and `/` commands. */
export function SuggestionMenu({
  title,
  items,
  active,
  onHover,
  onPick,
}: {
  title: string;
  items: Suggestion[];
  active: number;
  onHover: (i: number) => void;
  onPick: (s: Suggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl animate-rise">
      <div className="border-b border-border px-3 py-1.5 text-3xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </div>
      <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1 scroll-thin">
        {items.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">No matches</div>
        )}
        {items.map((s, i) => {
          const Icon = icons[s.icon];
          return (
            <div
              key={s.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              data-index={i}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]",
                i === active && "bg-accent",
              )}
            >
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  s.icon === "skill" ? "text-primary" : "text-muted-foreground",
                )}
              />
              {/* The name keeps its width (up to most of the row); a long description is cut. */}
              <span
                className={cn(
                  "max-w-[70%] shrink-0 truncate",
                  (s.icon === "file" || s.icon === "dir") && "font-mono text-[12px]",
                )}
              >
                {s.label}
              </span>
              {s.description && (
                <span
                  title={s.description}
                  className="ml-auto min-w-0 truncate pl-3 text-2xs text-muted-foreground"
                >
                  {s.description}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
