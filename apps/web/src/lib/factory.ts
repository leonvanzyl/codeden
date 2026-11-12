import type { EventEnvelope, FactoryStatus } from "@codeden/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useClient } from "./api";
import { ApiRequestError } from "./api/http";

/** Query keys of the factory views (§10.1); all start with `factory`. */
export const factoryKeys = {
  all: ["factory"] as const,
  status: (projectId: string) => ["factory", "status", projectId] as const,
  item: (projectId: string, itemId: string) => ["factory", "item", projectId, itemId] as const,
  vision: (projectId: string) => ["factory", "vision", projectId] as const,
};

const FACTORY_EVENTS = new Set<string>([
  "factory.loop.updated",
  "factory.item.updated",
  "factory.digest.created",
  "project.updated",
  "settings.updated",
]);

/** Refetch factory views when the loop, its items, the project or the kill switches change. */
export function invalidateFactory(queryClient: QueryClient, env: EventEnvelope): void {
  if (FACTORY_EVENTS.has(env.type)) {
    void queryClient.invalidateQueries({ queryKey: ["factory", "status"] });
    void queryClient.invalidateQueries({ queryKey: ["factory", "item"] });
  }
}

/** Status refresh while work is in flight: spend and session counts move without events. */
export const BUSY_REFRESH_MS = 30_000;
/**
 * Status refresh while the factory is idle. Everything the loop changes arrives as an event
 * (above); this slow poll only keeps spend from the project's other sessions (budget scope
 * "project") and the "last check" current, since a loop check that changes nothing sends none.
 */
export const IDLE_REFRESH_MS = 5 * 60_000;

/** How often an open factory view refetches its status: fast only while work is in flight. */
export function statusRefreshMs(status: FactoryStatus | undefined): number {
  const busy =
    !status ||
    status.activeSessions > 0 ||
    status.inProgress.length > 0 ||
    status.loopState === "discovering";
  return busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS;
}

/**
 * The factory panel's status: refetched on every factory event, and polled (see
 * `statusRefreshMs`), so its "last check" is as of the last refresh.
 */
export function useFactoryStatus(projectId: string, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.status(projectId),
    queryFn: () => client.factory.status(projectId),
    enabled,
    refetchInterval: (query) => statusRefreshMs(query.state.data),
  });
}

export function useFactoryItem(projectId: string, itemId: string) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.item(projectId, itemId),
    queryFn: () => client.factory.item(projectId, itemId),
  });
}

export function useVision(projectId: string) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.vision(projectId),
    queryFn: () => client.factory.vision(projectId),
  });
}

const MODE_ERRORS: Record<string, string> = {
  not_a_github_project: "The software and dark factory need a GitHub project.",
  vision_required: "Write and save the vision file first.",
  limits_required: "Set the factory limits first.",
  budget_required: "Set a daily budget (dollars or tokens).",
};

/** A readable reason for a refused mode switch. */
export function modeErrorText(error: Error): string {
  if (error instanceof ApiRequestError) return MODE_ERRORS[error.code] ?? error.message;
  return error.message;
}
