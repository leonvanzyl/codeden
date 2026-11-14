import type { FactoryItem, Project } from "@codeden/contracts";
import { untilText } from "./availability";
import { type FactoryContext, factoryNotice } from "./context";
import { prAgent } from "./rebase";

/**
 * Work waiting on a provider (§10.1, Provider availability): an item that failed for a reason
 * outside its code goes back by itself only once its builder's provider can take work again.
 * While that provider is signed out, at its usage limit or not installed, the item's open PR
 * doesn't count toward the work-in-progress limit (`wip.ts`), so a provider being out never
 * stops new work on the others. The status says which PRs wait on what, and the PM hears once
 * when work has waited on a provider for `PROVIDER_WAIT_NOTICE_MS`.
 */

/** How long work waits on its provider before the PM hears (provider detection runs this often). */
export const PROVIDER_WAIT_NOTICE_MS = 5 * 60_000;

/** When the item began waiting on its provider; dropped when it goes back (`recover.ts`). */
const WAITING_SINCE = "provider_wait";
/** When the PM was told the item waits on its provider. */
const TOLD = "provider_wait_told";

/** A recoverable item and the provider it waits for (null: any provider, while none can work). */
export interface ProviderWait {
  item: FactoryItem;
  provider: string | null;
}

/**
 * The provider a recoverable item waits for before it can go back: its builder's, while that
 * one can't take work, or any provider (null) while none can. Undefined when no provider holds
 * it back. `available` is `ctx.sessions.providers()`.
 */
export function awaitedProvider(
  ctx: FactoryContext,
  item: FactoryItem,
  available: readonly string[],
): string | null | undefined {
  const builder = prAgent(ctx, item);
  if (builder && !available.includes(builder.provider)) return builder.provider;
  return available.length === 0 ? null : undefined;
}

/** "Codex (not signed in)", "Codex (at its usage limit until Tue 06:00)". */
function providerText(ctx: FactoryContext, provider: string | null): string {
  if (!provider) return "a provider that can take work";
  const u = ctx.sessions.unavailable().find((p) => p.provider === provider);
  const why = u ? `${u.reason}${untilText(u.until)}` : "not available";
  return `${ctx.sessions.displayName(provider)} (${why})`;
}

/** The waits per provider, in the order first seen. */
function byProvider(waits: readonly ProviderWait[]): Map<string | null, FactoryItem[]> {
  const groups = new Map<string | null, FactoryItem[]>();
  for (const w of waits) groups.set(w.provider, [...(groups.get(w.provider) ?? []), w.item]);
  return groups;
}

/** "1 PR waits on Codex (not signed in) and doesn't count"; null when nothing waits. */
export function providerWaitText(
  ctx: FactoryContext,
  waits: readonly ProviderWait[],
): string | null {
  if (waits.length === 0) return null;
  const parts = [...byProvider(waits)].map(([provider, items]) => {
    const one = items.length === 1;
    return `${items.length} PR${one ? "" : "s"} ${one ? "waits" : "wait"} on ${providerText(ctx, provider)}`;
  });
  return `${parts.join("; ")} and ${waits.length === 1 ? "doesn't" : "don't"} count`;
}

/**
 * Keep track of how long each item has waited on its provider, and tell the PM once about the
 * items that waited `PROVIDER_WAIT_NOTICE_MS` (one notice per provider). Items that go back
 * start afresh (`recover.ts` drops both marks).
 */
export function noteProviderWaits(
  ctx: FactoryContext,
  project: Project,
  waits: readonly ProviderWait[],
): void {
  const now = ctx.now();
  const at = now.toISOString();
  const due: ProviderWait[] = [];
  for (const w of waits) {
    const since = w.item.nudges[WAITING_SINCE];
    if (!since) {
      ctx.store.updateItem(w.item.id, (i) => ({
        ...i,
        nudges: { ...i.nudges, [WAITING_SINCE]: at },
      }));
    } else if (
      !w.item.nudges[TOLD] &&
      now.getTime() - Date.parse(since) >= PROVIDER_WAIT_NOTICE_MS
    ) {
      due.push(w);
    }
  }
  for (const [provider, items] of byProvider(due)) {
    const what = providerText(ctx, provider);
    const prs = items.flatMap((i) => (i.pr ? [`#${i.pr.number}`] : []));
    factoryNotice(ctx, {
      id: `factory.provider-wait:${project.id}:${provider ?? "any"}:${at}`,
      projectId: project.id,
      target: "pm",
      event: "failed",
      title: `Factory work waits on ${what}`,
      text: [
        `${items.length} factory item${items.length === 1 ? "" : "s"} (${items.map((i) => i.title).join(", ")}) failed for a reason outside their code and go back by themselves once ${provider ? ctx.sessions.displayName(provider) : "a provider"} can take work again; until then new work goes to the other providers.`,
        prs.length
          ? `Their open pull requests (${prs.join(", ")}) don't count toward the open-PR limit meanwhile.`
          : "",
        "Ask the user to sign it in, or wait for its usage limit to reset.",
      ]
        .filter(Boolean)
        .join(" "),
      itemIds: items.map((i) => i.id),
    });
    for (const item of items) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [TOLD]: at } }));
    }
  }
}
