import type { Item } from "@codeden/contracts";
import { cmd, edit, read, search, thought } from "./fixtures/item-builders";
import { uid } from "./live";
import type { MockWorld } from "./world";

/**
 * The busy factory's agents at work in the mock UI (#264): while the storefront's Factory view is
 * open, its live sessions start a tool call now and then, so pixel mode's thought bubbles have
 * something to show. One session every 1.5 s, in turn. Mock only; nothing here calls a model.
 */

const EVERY_MS = 1500;

/** What each session does, in turn. Commands carry arguments the bubbles must not show. */
const WORK: Record<string, ((id: string) => Item)[]> = {
  "s-demo-build-151": [
    (id) => read(id, "docs/DESIGN.md", 120, 180),
    (id) => search(id, "prefers-color-scheme", 4, "src"),
    (id) =>
      edit(id, [{ path: "src/theme/tokens.ts", change: "modify", additions: 24, deletions: 3 }]),
    (id) => cmd(id, "pnpm test -- --run src/theme", "", null),
  ],
  "s-demo-review-57": [
    (id) => read(id, "src/search/filters.ts"),
    (id) => thought(id, "Checking the price filter's edge cases"),
    (id) => cmd(id, "pnpm vitest run src/search --reporter=dot", "", null),
  ],
  "s-demo-review-59": [
    (id) =>
      cmd(id, "GITHUB_TOKEN=ghp_demo0000000000000000000000 gh pr checks 59 --watch", "", null),
    (id) => read(id, "src/cart/coupon.ts"),
  ],
  "s-audit": [
    (id) => search(id, "dangerouslySetInnerHTML", 2, "src"),
    (id) => read(id, "src/payments/webhook.ts"),
  ],
  "s-search": [
    (id) =>
      edit(id, [
        { path: "src/cart/cart-drawer.tsx", change: "modify", additions: 9, deletions: 7 },
      ]),
    (id) => cmd(id, "git rebase --continue", "", null),
  ],
};

export function startActivityDemo(world: MockWorld, onView: () => boolean): () => void {
  const sessions = Object.keys(WORK);
  const turns = new Map<string, string>();
  let i = 0;
  const timer = window.setInterval(() => {
    if (!onView()) return;
    const sessionId = sessions[i % sessions.length] as string;
    const steps = WORK[sessionId] ?? [];
    const step = steps[Math.floor(i / sessions.length) % steps.length];
    i += 1;
    if (!step || !world.session(sessionId)) return;
    const threadId = world.transcript(sessionId).rootThreadId ?? `t-${sessionId}`;
    let turnId = turns.get(sessionId);
    if (!turnId) {
      turnId = uid("demo-turn");
      turns.set(sessionId, turnId);
      world.emitAgent(sessionId, { type: "turn.started", threadId, turnId });
    }
    const item = step(uid("demo-item"));
    world.emitAgent(sessionId, { type: "item.started", threadId, turnId, item });
  }, EVERY_MS);
  return () => window.clearInterval(timer);
}
