import type { ProviderInfo, ReasoningEffort } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSetupStatus } from "@/lib/queries";
import { matchesCombo, shortcut } from "@/lib/shortcuts";
import { isCustom, withCustomModels } from "./custom";
import { EffortColumn, focusEffort } from "./effort-column";
import { isHidden, visibleRows } from "./hidden";
import {
  adjacentTab,
  chooseModel,
  effectiveEffort,
  effortLevels,
  favoriteRows,
  type ModelChoice,
  type ModelRow,
  modelName,
  openProviderTabs,
  type PickerTab,
  providerAvailability,
  providerTabs,
  resolvedEfforts,
  resolveModel,
  rowKey,
  searchRows,
  tabRows,
} from "./logic";
import { ModelList, SetupNotice } from "./model-list";
import { ProviderRail } from "./provider-rail";
import { PickerTrigger } from "./trigger";
import { useCustomModels, useFavoriteModels, useHiddenModels } from "./use-model-settings";
import { useRefreshModels } from "./use-refresh-models";

export interface ModelPickerProps {
  providers: ProviderInfo[];
  /** The current choice; `null` shows `placeholder` (e.g. "Auto"). */
  value: ModelChoice | null;
  onChange: (next: ModelChoice) => void;
  /** The provider is fixed (a started session): other providers show but can't be opened. */
  lockedProvider?: string;
  /**
   * With `lockedProvider`: the other providers' tiles offer to continue the session in a new
   * one on that provider (§9), opening `onHandoff`; `blocked` says why that can't run now.
   */
  handoff?: { blocked: string | null; onHandoff: (providerId: string) => void };
  /** Offer effort levels beside the list (default true). */
  effort?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Extra actions under the picker, e.g. "Use the project default". */
  footer?: (close: () => void) => ReactNode;
  /** Open with the model picker shortcut (one picker per screen should set this). */
  shortcut?: boolean;
  align?: "start" | "end";
}

const valueKey = (v: ModelChoice | null) => (v ? `${v.provider}|${v.model}|${v.effort}` : "");

/**
 * Provider, model and effort in one control. The trigger names all three; the popover has a
 * provider rail, a searchable model list and, docked beside it, the selected model's effort
 * levels. Picking a model moves focus to its levels; picking a level closes the picker.
 */
export function ModelPicker({
  providers: listed,
  value,
  onChange,
  lockedProvider,
  handoff,
  effort: offerEffort = true,
  disabled,
  placeholder = "Choose a model",
  footer,
  shortcut: listen,
  align = "start",
}: ModelPickerProps) {
  const navigate = useNavigate();
  const checks = useSetupStatus({ staleTime: 60_000 }).data?.checks;
  const [open, setOpen] = useState(false);
  const [tabId, setTabId] = useState("");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // What was just picked shows at once, until the owner passes the new value back.
  const [optimistic, setOptimistic] = useState<ModelChoice | null>(null);
  const [seen, setSeen] = useState(valueKey(value));
  if (seen !== valueKey(value)) {
    setSeen(valueKey(value));
    setOptimistic(null);
  }
  const shown = optimistic ?? value;

  const { favorites, toggle: toggleFavorite } = useFavoriteModels();
  const { hidden, toggle: toggleHidden } = useHiddenModels();
  // The user's custom model ids join the listed ones (§13).
  const { custom } = useCustomModels();
  const providers = withCustomModels(listed, custom);
  const tabs = providerTabs(providers, checks, lockedProvider, {
    favorites: true,
    ...(handoff ? { handoff: { blocked: handoff.blocked } } : {}),
  });
  const openTabs = openProviderTabs(tabs);
  const tab: PickerTab | undefined = tabs.find((t) => t.id === tabId) ?? openTabs[0];
  const provider = providers.find((p) => p.id === shown?.provider);
  const resolved = resolveModel(provider, shown?.model ?? null);
  const model = shown ? resolved.model : undefined;
  const { levels, defaultEffort } = shown
    ? resolvedEfforts(provider, resolved)
    : { levels: [], defaultEffort: undefined };
  const effort = shown ? effectiveEffort(levels, shown.effort, defaultEffort) : null;
  const selectedKey = provider && model ? rowKey(provider.id, model.id) : null;
  const showColumn = offerEffort && openTabs.some((t) => t.provider.capabilities.reasoningEffort);
  // "Refresh models" asks the shown provider again; on Favourites, every provider offered here.
  const models = useRefreshModels();
  const refreshIds =
    tab?.kind === "provider"
      ? [tab.id]
      : openTabs.map((t) => t.id).filter((id) => listed.some((p) => p.id === id));
  const refresh =
    refreshIds.length > 0
      ? {
          label:
            tab?.kind === "provider"
              ? `Refresh ${tab.provider.displayName}'s models`
              : "Refresh every provider's models",
          busy: models.refreshing,
          onRefresh: () => void models.refresh(refreshIds),
        }
      : undefined;

  const searching = query.trim().length > 0;
  const searchable = openTabs.map((t) => t.provider);
  // Hidden models are left out everywhere unless selected, or revealed on a provider tab.
  const listFor = (q: string, t: PickerTab | undefined, reveal: boolean) =>
    visibleRows(
      q.trim() ? searchRows(searchable, q, favorites) : tabRows(t, searchable, favorites),
      hidden,
      selectedKey,
      reveal && !q.trim() && t?.kind === "provider",
    );
  const rowsFor = (q: string, t: PickerTab | undefined): ModelRow[] => listFor(q, t, false).rows;
  const list = listFor(query, tab, showHidden);
  const rows = list.rows;
  const starred = new Set(favorites.map((f) => rowKey(f.provider, f.model)));
  const notice =
    !searching && tab?.kind === "provider" && !tab.availability.ready ? (
      <SetupNotice
        name={tab.provider.displayName}
        availability={tab.availability}
        onOpenSetup={() => {
          setOpen(false);
          void navigate({ to: "/setup" });
        }}
      />
    ) : undefined;

  const firstKey = (list: ModelRow[]) =>
    list.find((r) => r.key === selectedKey)?.key ?? list[0]?.key ?? "";

  const showTab = (id: string, focusSearch = true) => {
    const next = tabs.find((t) => t.id === id);
    setTabId(id);
    setQuery("");
    setShowHidden(false);
    setHighlight(firstKey(rowsFor("", next)));
    if (focusSearch) requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openPicker = (next: boolean) => {
    if (next) {
      // Starred models come first, except when the provider is fixed for this session.
      const start =
        (!lockedProvider &&
        visibleRows(favoriteRows(favorites, searchable), hidden, selectedKey, false).rows.length > 0
          ? tabs.find((t) => t.kind === "favorites")
          : undefined) ??
        openTabs.find((t) => t.id === shown?.provider) ??
        openTabs.find((t) => t.id === lockedProvider) ??
        openTabs[0];
      showTab(start?.id ?? "", false);
    } else {
      setOptimistic(null);
    }
    setOpen(next);
  };

  const commit = (next: ModelChoice) => {
    setOptimistic(next);
    onChange(next);
  };

  const pick = (row: ModelRow) => {
    const current = shown ?? { provider: row.provider.id, model: null, effort: null };
    const next = chooseModel(current, row.provider, row.model);
    // Picking the checked row keeps "the default" as the default rather than pinning it.
    if (row.key === selectedKey) next.model = current.model;
    commit(next);
    if (showColumn && effortLevels(row.provider, row.model).length > 0) {
      requestAnimationFrame(() => focusEffort(contentRef.current));
    } else {
      setOpen(false);
    }
  };

  const pickEffort = (level: ReasoningEffort) => {
    if (shown) commit({ ...shown, effort: level });
    setOpen(false);
  };

  const toEffort = () => {
    const row = rows.find((r) => r.key === highlight);
    if (row && row.key !== selectedKey) pick(row);
    else focusEffort(contentRef.current);
  };

  // Ctrl/Cmd+Shift+Up/Down switch provider from anywhere in the popover.
  const onContentKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const next = adjacentTab(tabs, tab?.id ?? "", e.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    showTab(next.id);
  };

  // The picker shortcut toggles it (the composer's picker listens).
  const onShortcut = useEffectEvent(() => openPicker(!open));
  useEffect(() => {
    if (!listen || disabled) return;
    const combo = shortcut("modelPicker").combo;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!matchesCombo(e, combo)) return;
      e.preventDefault();
      onShortcut();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listen, disabled]);

  return (
    <Popover open={open} onOpenChange={openPicker}>
      <PopoverTrigger asChild disabled={disabled}>
        <PickerTrigger
          providerId={shown?.provider ?? null}
          provider={provider}
          resolved={resolved}
          modelId={shown?.model ?? null}
          effort={offerEffort ? effort : null}
          levels={offerEffort ? levels : []}
          placeholder={placeholder}
          ready={!provider || providerAvailability(provider.id, checks).ready}
        />
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align={align}
        collisionPadding={8}
        className="w-auto max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onKeyDownCapture={onContentKeyDown}
        data-testid="model-picker"
      >
        {tabs.length === 0 ? (
          <p className="w-72 px-4 py-6 text-center text-xs text-muted-foreground">
            No providers are connected. Check that the runner is running.
          </p>
        ) : (
          <div className="flex h-80 max-sm:h-auto max-sm:flex-col">
            <div className="flex min-h-0 max-sm:h-64">
              {!searching && (
                <ProviderRail
                  tabs={tabs}
                  selectedId={tab?.id ?? ""}
                  onSelect={(id) => showTab(id, false)}
                  onFocusSearch={() => inputRef.current?.focus()}
                  onHandoff={
                    handoff
                      ? (id) => {
                          openPicker(false);
                          handoff.onHandoff(id);
                        }
                      : undefined
                  }
                  refresh={refresh}
                />
              )}
              <div className="flex w-80 min-w-0 flex-col max-sm:w-auto max-sm:flex-1">
                <ModelList
                  inputRef={inputRef}
                  query={query}
                  onQueryChange={(q) => {
                    setQuery(q);
                    setHighlight(rowsFor(q, tab)[0]?.key ?? "");
                  }}
                  rows={rows}
                  selectedKey={selectedKey}
                  highlight={highlight}
                  onHighlight={setHighlight}
                  notice={notice}
                  empty={
                    tab?.kind === "favorites"
                      ? "No favourites yet. Star a model to pin it here."
                      : undefined
                  }
                  isFavorite={(row) => starred.has(row.key)}
                  isHidden={(row) => isHidden(hidden, row.provider.id, row.model.id)}
                  isCustom={(row) =>
                    isCustom(
                      custom,
                      listed.find((p) => p.id === row.provider.id),
                      row.provider.id,
                      row.model.id,
                    )
                  }
                  hiddenToggle={
                    !searching && tab?.kind === "provider"
                      ? {
                          count: list.hiddenCount,
                          shown: showHidden,
                          onToggle: () => setShowHidden((v) => !v),
                        }
                      : undefined
                  }
                  onToggleHidden={(row) => toggleHidden(row.provider.id, row.model.id)}
                  onToggleFavorite={(row) =>
                    toggleFavorite({ provider: row.provider.id, model: row.model.id })
                  }
                  onPick={pick}
                  onFocusRail={() =>
                    contentRef.current
                      ?.querySelector<HTMLElement>('[data-picker-tab][aria-pressed="true"]')
                      ?.focus()
                  }
                  onFocusEffort={showColumn ? toEffort : undefined}
                />
              </div>
            </div>
            {showColumn && (
              <EffortColumn
                modelLabel={modelName(resolved) ?? ""}
                missing={Boolean(resolved.missing)}
                levels={levels}
                value={effort}
                defaultEffort={defaultEffort}
                onPick={pickEffort}
                onBack={() => inputRef.current?.focus()}
              />
            )}
          </div>
        )}
        {footer && (
          <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-2 py-1.5">
            {footer(() => setOpen(false))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
