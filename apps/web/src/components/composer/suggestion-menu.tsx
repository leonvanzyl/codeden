import { File, Folder, Sparkles, SquareSlash } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Trigger } from "./trigger";

export interface Suggestion {
  id: string;
  label: string;
  description?: string;
  icon: "file" | "dir" | "command" | "skill";
  /** Text inserted in place of the trigger. */
  insert: string;
}

const icons = { file: File, dir: Folder, command: SquareSlash, skill: Sparkles };
/** What a screen reader hears after an option's label. */
const kinds = { file: "file", dir: "folder", command: "command", skill: "skill" };

/**
 * The DOM id of an option in the list `listId`, which the composer box names as its active
 * descendant. It comes from the item alone (its kind and id, never its position), so an option
 * keeps its id while typing narrows or reorders the list, and moving to a different item
 * always changes the id and is announced.
 */
export const suggestionOptionId = (listId: string, s: Suggestion) =>
  `${listId}-${s.icon}-${encodeURIComponent(s.id)}`;

/**
 * What the composer's live region says about the open menu: the number of results, or that
 * nothing matches, for the filter as typed (`/re`, `@src`). Naming the filter changes the text
 * with every change of filter, so it is announced again even when the count stays the same.
 * Silent while the menu is closed or its results are loading, so an empty list on the way to
 * results is not announced as "No matches".
 */
export function suggestionStatus(
  open: boolean,
  loading: boolean,
  count: number,
  trigger: Trigger | null,
): string {
  if (!open || loading) return "";
  const results = count === 0 ? "No matches" : count === 1 ? "1 result" : `${count} results`;
  if (!trigger?.query) return results;
  return `${results} for ${trigger.kind === "command" ? "/" : "@"}${trigger.query}`;
}

/**
 * Floating list above the composer for `@` mentions and `/` commands. It is the listbox of the
 * composer box's combobox: the box keeps focus and points at the highlighted option by its id.
 */
export function SuggestionMenu({
  id,
  title,
  items,
  active,
  onHover,
  onPick,
}: {
  /** The listbox's DOM id, which the composer box controls. */
  id: string;
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
      <div
        id={`${id}-title`}
        className="border-b border-border px-3 py-1.5 text-3xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        {title}
      </div>
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-labelledby={`${id}-title`}
        className="max-h-64 overflow-y-auto p-1 scroll-thin"
      >
        {items.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">No matches</div>
        )}
        {items.map((s, i) => {
          const Icon = icons[s.icon];
          const optionId = suggestionOptionId(id, s);
          return (
            <div
              key={s.id}
              id={optionId}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              aria-label={`${s.label}, ${kinds[s.icon]}`}
              aria-describedby={s.description ? `${optionId}-description` : undefined}
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
                  id={`${optionId}-description`}
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
