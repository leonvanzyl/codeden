import type { EventEnvelope } from "@codeden/contracts";
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

export function useFactoryStatus(projectId: string, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.status(projectId),
    queryFn: () => client.factory.status(projectId),
    enabled,
    // Spend and session counts move without loop events.
    refetchInterval: 30_000,
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
