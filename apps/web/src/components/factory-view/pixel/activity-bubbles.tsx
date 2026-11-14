import { Brain, FileText, Globe, type LucideIcon, Pencil, Search, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ActivityKind, bubbleOf } from "./activity";
import { SCENE_H, SCENE_W } from "./floor";
import type { SceneTarget } from "./targets";
import { type ActivityStore, useActivityVersion } from "./use-activity";

/**
 * The thought bubbles over the floor (#264): what each agent on screen is doing right now, one
 * bubble per agent at most, fading a few seconds after it appeared. They are drawn over the
 * canvas so the text stays crisp, and re-render on their own, not with the scene. Decorative for
 * screen readers: the agent's card lists the same activities.
 */

export const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  edit: Pencil,
  run: Terminal,
  read: FileText,
  search: Search,
  web: Globe,
  think: Brain,
};

export function ActivityBubbles({
  store,
  targets,
  pinned,
}: {
  store: ActivityStore;
  targets: readonly SceneTarget[];
  /** The hovered or focused agent's target key: its bubble stays. */
  pinned: string | null;
}) {
  useActivityVersion(store);
  const now = Date.now();
  return targets.map((t) => {
    if (t.kind !== "agent" || !t.agent.sessionId) return null;
    const bubble = bubbleOf(store.get(t.agent.sessionId), now, pinned === t.key);
    if (!bubble) return null;
    const Icon = ACTIVITY_ICON[bubble.activity.kind];
    return (
      <div
        key={t.key}
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-10 flex max-w-44 items-center gap-1 rounded-[3px] border-2 border-[#1a1c2c] bg-white px-1 py-px font-mono text-[10px] leading-tight whitespace-nowrap text-[#1a1c2c] shadow-[2px_2px_0_#1a1c2c] transition-opacity duration-1000 motion-reduce:transition-none",
          bubble.fading ? "opacity-0" : "opacity-100",
        )}
        style={{
          left: `${((t.rect.x + t.rect.w / 2) / SCENE_W) * 100}%`,
          top: `${(t.rect.y / SCENE_H) * 100}%`,
          transform: "translate(-50%, calc(-100% - 3px))",
        }}
        data-testid="factory-view-pixel-bubble"
        data-kind={bubble.activity.kind}
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{bubble.activity.text}</span>
      </div>
    );
  });
}

/** The hovered agent's latest activities, newest first, for its card. */
export function RecentActivity({
  store,
  sessionId,
}: {
  store: ActivityStore;
  sessionId: string | null;
}) {
  useActivityVersion(store);
  const history = store.get(sessionId).history;
  if (history.length === 0) return null;
  return (
    <div data-testid="factory-view-pixel-card-activity">
      <p className="text-[#3d4660]">Latest activity</p>
      <ul className="space-y-0.5">
        {history.map((a) => {
          const Icon = ACTIVITY_ICON[a.kind];
          return (
            <li key={a.itemId} className="flex items-center gap-1">
              <Icon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{a.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
