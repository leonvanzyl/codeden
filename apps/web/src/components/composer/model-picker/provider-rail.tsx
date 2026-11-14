import { RefreshCw, Star } from "lucide-react";
import { Fragment, type KeyboardEvent } from "react";
import { ProviderMark } from "@/components/common/bits";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PickerTab } from "./logic";

function tabLabel(tab: PickerTab): string {
  if (tab.kind === "favorites") return "Favourites";
  if (tab.lockedReason) return tab.lockedReason;
  const { availability, provider } = tab;
  if (availability.ready) return provider.displayName;
  return `${provider.displayName}: ${availability.reason}${availability.detail ? `. ${availability.detail}` : ""}`;
}

/** Up and Down move between open tabs and select them; Right goes to the search box. */
function onRailKeyDown(
  e: KeyboardEvent<HTMLDivElement>,
  tabs: PickerTab[],
  selectedId: string,
  onSelect: (id: string) => void,
  onFocusSearch: () => void,
) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === "ArrowRight") {
    e.preventDefault();
    onFocusSearch();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const open = tabs.filter((t) => !t.lockedReason);
  const index = open.findIndex((t) => t.id === selectedId);
  const next =
    open[Math.min(open.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  onSelect(next.id);
  const tiles = e.currentTarget.querySelectorAll<HTMLElement>("[data-picker-tab]");
  Array.from(tiles)
    .find((tile) => tile.dataset.pickerTab === next.id)
    ?.focus();
}

/**
 * The provider rail on the left of the picker: Favourites, then one tile per provider. Tiles of
 * providers that are not set up are dimmed (and still open, to show how to fix them); tiles
 * that can't be used here, such as other providers in a running session, are disabled with the
 * reason on hover, unless they offer a handoff (§9): those open it on click.
 */
export function ProviderRail({
  tabs,
  selectedId,
  onSelect,
  onFocusSearch,
  onHandoff,
  refresh,
}: {
  tabs: PickerTab[];
  selectedId: string;
  onSelect: (id: string) => void;
  onFocusSearch: () => void;
  /** A locked provider's tile that offers a handoff was clicked. */
  onHandoff?: (providerId: string) => void;
  /** "Refresh models" at the foot of the rail, for the shown tab's provider(s). */
  refresh?: { label: string; busy: boolean; onRefresh: () => void };
}) {
  return (
    <div
      role="toolbar"
      aria-label="Providers"
      aria-orientation="vertical"
      data-picker-rail
      className="flex w-11 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-muted/20 p-1 no-scrollbar"
      onKeyDown={(e) => onRailKeyDown(e, tabs, selectedId, onSelect, onFocusSearch)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === selectedId;
        const handoff = tab.kind === "provider" && tab.handoff === "ready" && onHandoff;
        const locked = Boolean(tab.lockedReason) && !handoff;
        const label = tabLabel(tab);
        return (
          <Fragment key={tab.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-picker-tab={tab.id}
                  data-picker-handoff={handoff ? true : undefined}
                  aria-label={label}
                  aria-pressed={handoff ? undefined : selected}
                  aria-haspopup={handoff ? "dialog" : undefined}
                  aria-disabled={locked || undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    if (handoff) handoff(tab.id);
                    else if (!locked) onSelect(tab.id);
                  }}
                  className={cn(
                    "relative flex aspect-square w-full items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                    selected && "bg-accent",
                    locked && "cursor-not-allowed opacity-40 hover:bg-transparent",
                    handoff && "opacity-60 hover:opacity-100",
                  )}
                >
                  {tab.kind === "favorites" ? (
                    <Star className="size-4 fill-current text-status-waiting" aria-hidden />
                  ) : (
                    <ProviderMark
                      provider={tab.provider.id}
                      className={cn("size-6 text-[11px]", !tab.availability.ready && "opacity-50")}
                    />
                  )}
                  {tab.kind === "provider" && !tab.availability.ready && !tab.lockedReason && (
                    <span
                      aria-hidden
                      className="absolute right-1 bottom-1 size-1.5 rounded-full bg-status-waiting ring-2 ring-popover"
                    />
                  )}
                  {selected && (
                    <span
                      aria-hidden
                      className="absolute top-1/2 -right-1 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={8} className="max-w-60">
                {label}
              </TooltipContent>
            </Tooltip>
            {tab.kind === "favorites" && (
              <div aria-hidden className="mx-1 border-b border-border" />
            )}
          </Fragment>
        );
      })}
      {refresh && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-picker-refresh
              aria-label={refresh.label}
              aria-busy={refresh.busy || undefined}
              disabled={refresh.busy}
              onClick={refresh.onRefresh}
              className="mt-auto flex aspect-square w-full shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait"
            >
              <RefreshCw className={cn("size-3.5", refresh.busy && "animate-spin")} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8} className="max-w-60">
            {refresh.busy ? "Refreshing models…" : refresh.label}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
