import {
  type AppearanceSettings,
  type Settings,
  type SettingsPatch,
  type Snapshot,
  THEME_TOKEN_KEYS,
} from "@codeden/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { CodeDenClient } from "@/lib/api/client";
import { snapshotKey } from "@/lib/queries";
import { appearanceOf, useThemeStore } from "@/stores/theme";

/** Appearance as JSON with a fixed key order, so equal settings compare equal. */
export function canonical(a: AppearanceSettings): string {
  const tokens = (t: Record<string, string | undefined>) =>
    Object.fromEntries(THEME_TOKEN_KEYS.filter((k) => t[k]).map((k) => [k, t[k]]));
  return JSON.stringify([
    a.theme,
    a.darkTheme,
    a.lightTheme,
    a.custom.dark.base,
    tokens(a.custom.dark.tokens),
    a.custom.light.base,
    tokens(a.custom.light.tokens),
  ]);
}

const DEFAULT = canonical({
  theme: "dark",
  darkTheme: "codeden-dark",
  lightTheme: "codeden-light",
  custom: {
    dark: { base: "codeden-dark", tokens: {} },
    light: { base: "codeden-light", tokens: {} },
  },
});

/**
 * What to do with the server's appearance: keep this window's (`push`), take the server's
 * (`adopt`) or nothing. Before the first sync, a window that never chose a theme takes the
 * server's, and one that did keeps its own only while the server still has the defaults.
 */
export function reconcile(
  local: string,
  server: string,
  synced: string | null,
): "adopt" | "push" | "none" {
  if (server === local) return "none";
  if (synced === null) {
    if (local === DEFAULT) return "adopt";
    return server === DEFAULT ? "push" : "adopt";
  }
  return server === synced ? "none" : "adopt";
}

/**
 * Keeps the theme in `settings.json`, so every window and the desktop app share it: changes
 * made here are saved (debounced, since the theme editor's colour inputs fire as they move), and
 * changes saved elsewhere arrive with the snapshot and are adopted. This window's own echo is
 * recognised by `synced`.
 */
export function startThemeSync(client: CodeDenClient, queryClient: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let adopting = false;

  const save = async () => {
    timer = null;
    saving = true;
    const state = useThemeStore.getState();
    const appearance = appearanceOf(state);
    try {
      // Patches deep-merge, so a colour reset to the preset's takes clearing the overrides first.
      const before = state.synced ? (JSON.parse(state.synced) as unknown[]) : null;
      for (const [kind, at] of [
        ["dark", 4],
        ["light", 6],
      ] as const) {
        const had = Object.keys((before?.[at] as object | undefined) ?? {});
        const has = Object.keys(appearance.custom[kind].tokens);
        if (had.some((k) => !has.includes(k))) {
          await client.updateSettings({
            appearance: { custom: { [kind]: { tokens: null } } },
          } as unknown as SettingsPatch);
        }
      }
      const settings: Settings = await client.updateSettings({ appearance });
      useThemeStore.setState({ synced: canonical(settings.appearance) });
    } catch {
      // Not saved (offline, an older server): this window keeps it; the next change retries.
    } finally {
      saving = false;
    }
  };

  const offStore = useThemeStore.subscribe((s, prev) => {
    if (adopting || canonical(appearanceOf(s)) === canonical(appearanceOf(prev))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 300);
  });

  const onServer = (server: AppearanceSettings | undefined) => {
    if (!server || timer || saving) return;
    const state = useThemeStore.getState();
    const remote = canonical(server);
    const action = reconcile(canonical(appearanceOf(state)), remote, state.synced);
    if (action === "push") {
      timer = setTimeout(() => void save(), 0);
      return;
    }
    adopting = true;
    try {
      if (action === "adopt") {
        useThemeStore.setState({
          preference: server.theme,
          darkTheme: server.darkTheme,
          lightTheme: server.lightTheme,
          custom: server.custom,
          synced: remote,
        });
      } else if (state.synced !== remote) {
        useThemeStore.setState({ synced: remote });
      }
    } finally {
      adopting = false;
    }
  };

  const read = () => queryClient.getQueryData<Snapshot>(snapshotKey)?.settings.appearance;
  onServer(read());
  const offCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === snapshotKey[0] && event.type === "updated") onServer(read());
  });
  return () => {
    offStore();
    offCache();
    if (timer) clearTimeout(timer);
  };
}
