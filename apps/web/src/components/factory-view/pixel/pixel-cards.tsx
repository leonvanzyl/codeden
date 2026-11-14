import type { FactoryWorkItem } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useRetryItem } from "@/components/factory/use-retry-item";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { cardNumber, cardStateLabel, type ViewCard } from "../stages";
import type { AgentCardModel } from "./agent-card";
import type { SceneAgent } from "./agents";
import { STATUS_COLOUR } from "./draw-agents";
import { type Rect, SCENE_H, SCENE_W } from "./floor";
import type { BayCrate } from "./repair-bay";

/**
 * The pixel mode's cards (#264), in the scene's own style: what an agent is doing on hover or
 * keyboard focus, and what a repair bay crate holds with the button that moves each item on.
 * They stay open while the pointer is on the thing or the card, so their buttons can be used.
 */

function PixelCard({
  anchor,
  children,
  onEnter,
  onLeave,
  testId,
  label,
}: {
  anchor: Rect;
  children: ReactNode;
  onEnter: () => void;
  onLeave: () => void;
  testId: string;
  label: string;
}) {
  // Below the thing when it's near the top; anchored to its side near the left and right edges.
  const below = anchor.y < SCENE_H * 0.45;
  const centre = anchor.x + anchor.w / 2;
  const align = centre < 90 ? "left" : centre > SCENE_W - 90 ? "right" : "centre";
  const x = align === "left" ? anchor.x : align === "right" ? anchor.x + anchor.w : centre;
  const shiftX = align === "left" ? "0" : align === "right" ? "-100%" : "-50%";
  return (
    <section
      aria-label={label}
      className="absolute z-20 w-72 max-w-[80%] border-2 border-[#1a1c2c] bg-[#fff8e7] font-mono text-[11px] leading-snug text-[#1a1c2c] shadow-[3px_3px_0_#1a1c2c]"
      style={{
        left: `${(x / SCENE_W) * 100}%`,
        top: below
          ? `calc(${((anchor.y + anchor.h) / SCENE_H) * 100}% + 2px)`
          : `calc(${(anchor.y / SCENE_H) * 100}% - 2px)`,
        transform: `translate(${shiftX}, ${below ? "0" : "-100%"})`,
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

const action =
  "border-2 border-[#1a1c2c] bg-[#ffcd75] px-1.5 py-0.5 font-semibold text-[#1a1c2c] shadow-[1px_1px_0_#1a1c2c] hover:bg-[#ffd98f] focus-visible:outline-2 focus-visible:outline-[#41a6f6] disabled:opacity-50";

/** The agent's card: role, item, step, provider and model, progress, time in step, status. */
export function AgentCardView({
  agent,
  card,
  anchor,
  onEnter,
  onLeave,
  onOpenItem,
  recent,
}: {
  agent: SceneAgent;
  card: AgentCardModel;
  anchor: Rect;
  onEnter: () => void;
  onLeave: () => void;
  /** Its latest activities (the thought bubbles' history). */
  recent?: ReactNode;
  /** Opens its item's sheet (the PM: its chat). */
  onOpenItem: (() => void) | null;
}) {
  return (
    <PixelCard
      anchor={anchor}
      onEnter={onEnter}
      onLeave={onLeave}
      testId="factory-view-pixel-card"
      label={`${card.role}: ${card.status}`}
    >
      <header className="flex items-center gap-1.5 border-b-2 border-[#1a1c2c] bg-[#262b44] px-1.5 py-1 text-[#f4f4f4]">
        <span className="font-semibold uppercase tracking-wide">{card.role}</span>
        <span
          className="ml-auto inline-flex items-center gap-1"
          data-testid="factory-view-pixel-card-status"
        >
          <span
            aria-hidden
            className="inline-block size-2 border border-[#1a1c2c]"
            style={{ background: STATUS_COLOUR[card.statusKind] }}
          />
          {card.status}
        </span>
      </header>
      <div className="space-y-1 px-1.5 py-1">
        {(card.refs || card.title) && (
          <p>
            {card.refs && <span className="mr-1 font-semibold">{card.refs}</span>}
            {card.title}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[#3d4660]">
          <dt>Step</dt>
          <dd className="font-semibold text-[#1a1c2c]">{card.step}</dd>
          {card.inStep && (
            <>
              <dt>In step</dt>
              <dd>{card.inStep}</dd>
            </>
          )}
          <dt>Agent</dt>
          <dd>{card.model}</dd>
        </dl>
        {card.progress && (
          <p className="border border-[#1a1c2c] bg-white px-1 italic">“{card.progress}”</p>
        )}
        {recent}
        {(onOpenItem || agent.sessionId) && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {onOpenItem && (
              <button type="button" className={action} onClick={onOpenItem}>
                {agent.role === "pm" ? "Chat" : "Open item"}
              </button>
            )}
            {agent.sessionId && (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: agent.sessionId }}
                className={cn(action, "bg-[#94b0c2] hover:bg-[#b0c8d6]")}
                data-testid="factory-view-pixel-card-session"
              >
                Open session
              </Link>
            )}
          </div>
        )}
      </div>
    </PixelCard>
  );
}

function RetryAction({ projectId, item }: { projectId: string; item: FactoryWorkItem }) {
  const retry = useRetryItem(projectId, item.id);
  return (
    <button
      type="button"
      className={action}
      disabled={retry.isPending}
      onClick={() => retry.mutate()}
      aria-label={`Retry ${cardNumber(item)}`}
    >
      Retry
    </button>
  );
}

/** A repair bay crate: each item in it, why it stopped and what to do. */
export function BayCardView({
  crate,
  anchor,
  projectId,
  onEnter,
  onLeave,
  onOpen,
}: {
  crate: BayCrate;
  anchor: Rect;
  projectId: string;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: (card: ViewCard) => void;
}) {
  return (
    <PixelCard
      anchor={anchor}
      onEnter={onEnter}
      onLeave={onLeave}
      testId="factory-view-pixel-bay-card"
      label={`Repair bay: ${crate.title}`}
    >
      <header className="flex items-center border-b-2 border-[#1a1c2c] bg-[#b13e53] px-1.5 py-1 font-semibold text-[#f4f4f4]">
        <span className="uppercase tracking-wide">{crate.title}</span>
        <span className="ml-auto">{crate.entries.length}</span>
      </header>
      <ul className="max-h-56 divide-y divide-[#1a1c2c]/30 overflow-y-auto">
        {crate.entries.map((e) => {
          const pr = e.card.pr?.pr ?? e.card.item.ownedPr ?? e.card.item.pr;
          return (
            <li
              key={e.card.item.id}
              className="space-y-1 px-1.5 py-1"
              data-testid="factory-view-pixel-bay-entry"
            >
              <button
                type="button"
                className="block text-left font-semibold hover:underline"
                onClick={() => onOpen(e.card)}
              >
                {cardNumber(e.card.item)} {e.card.item.title}
              </button>
              <p className="text-[#b13e53]">{e.label}</p>
              <div className="flex gap-1.5">
                {e.action === "retry" && <RetryAction projectId={projectId} item={e.card.item} />}
                {e.action === "open_pr" && pr && (
                  <button
                    type="button"
                    className={action}
                    onClick={() => platform.openExternal(pr.url)}
                  >
                    Open PR #{pr.number}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </PixelCard>
  );
}

/** A ticket at intake: its number, title and state (it opens its sheet on click). */
export function TicketTip({ card, anchor }: { card: ViewCard; anchor: Rect }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 w-max max-w-64 border-2 border-[#1a1c2c] bg-[#fff8e7] px-1.5 py-1 font-mono text-[11px] leading-snug text-[#1a1c2c] shadow-[2px_2px_0_#1a1c2c]"
      style={{
        left: `${(anchor.x / SCENE_W) * 100}%`,
        top: `calc(${((anchor.y + anchor.h) / SCENE_H) * 100}% + 2px)`,
      }}
      data-testid="factory-view-pixel-tip"
    >
      <div className="font-semibold">
        {cardNumber(card.item)} {card.item.title}
      </div>
      <div className="text-[#566c86]">{cardStateLabel(card)}</div>
    </div>
  );
}
