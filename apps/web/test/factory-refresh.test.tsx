import {
  type EventEnvelope,
  FactoryLimits,
  FactoryStatus,
  FactoryTuning,
} from "@codeden/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider, type CodeDenClient } from "@/lib/api";
import {
  BUSY_REFRESH_MS,
  IDLE_REFRESH_MS,
  invalidateFactory,
  useFactoryStatus,
} from "@/lib/factory";

/**
 * Issue #139: an idle factory sends no events, and an open factory panel must not keep fetching
 * its whole status every 30 s either. It polls fast only while work is in flight; factory
 * events still refresh it at once.
 */

const IDLE = FactoryStatus.parse({
  projectId: "p-app",
  mode: "software_factory",
  experimental: true,
  loopState: "idle",
  pausedReason: null,
  killSwitch: false,
  globalKillSwitch: false,
  limits: FactoryLimits.parse({ dailyBudget: { usd: 10 } }),
  tuning: FactoryTuning.parse({}),
  spendToday: { usd: 0, tokens: 0 },
  mergesToday: 0,
  consecutiveFailures: 0,
  activeSessions: 0,
  backlog: [],
  inProgress: [],
  mergeChecks: [],
  recent: [],
  visionExists: true,
  lastDigest: null,
  lastTickAt: "2026-11-12T10:00:00.000Z",
});
const BUSY: FactoryStatus = { ...IDLE, loopState: "building", activeSessions: 1 };

const event = (type: string) => ({ type, seq: 1, sessionId: null }) as unknown as EventEnvelope;

let queryClient: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

/** Mount the status hook; `reply.status` is what the server answers next. */
async function mount(first: FactoryStatus) {
  const reply = { status: first };
  const status = vi.fn(async () => reply.status);
  const client = { factory: { status } } as unknown as CodeDenClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ClientProvider>
  );
  const hook = renderHook(() => useFactoryStatus("p-app"), { wrapper });
  await advance(0);
  expect(status).toHaveBeenCalledTimes(1);
  return { reply, status, hook };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("the factory status refresh (#139)", () => {
  it("does not refetch an idle factory's status every 30 s", async () => {
    const { status, hook } = await mount(IDLE);
    await advance(BUSY_REFRESH_MS);
    await advance(BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(1);
    // The slow poll still brings the "last check" up to date.
    await advance(IDLE_REFRESH_MS - 2 * BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("polls every 30 s while work is in flight", async () => {
    const { status, hook } = await mount(BUSY);
    await advance(BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(2);
    await advance(BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("refreshes an idle panel on factory events and polls fast once work starts", async () => {
    const { reply, status, hook } = await mount(IDLE);
    // Not a factory event: nothing to refresh.
    act(() => invalidateFactory(queryClient, event("session.updated")));
    await advance(0);
    expect(status).toHaveBeenCalledTimes(1);
    // A builder picks up an item.
    reply.status = BUSY;
    act(() => invalidateFactory(queryClient, event("factory.item.updated")));
    await advance(0);
    expect(status).toHaveBeenCalledTimes(2);
    expect(hook.result.current.data?.activeSessions).toBe(1);
    await advance(BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(3);
    // The work is done: back to the slow poll.
    reply.status = IDLE;
    act(() => invalidateFactory(queryClient, event("factory.item.updated")));
    await advance(0);
    expect(status).toHaveBeenCalledTimes(4);
    await advance(BUSY_REFRESH_MS);
    await advance(BUSY_REFRESH_MS);
    expect(status).toHaveBeenCalledTimes(4);
    hook.unmount();
  });
});
