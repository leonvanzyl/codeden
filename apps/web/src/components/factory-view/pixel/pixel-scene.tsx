import type { FactoryStatus } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  cardNumber,
  cardStateLabel,
  type SessionInfo,
  type ViewCard,
  type ViewPipeline,
} from "../stages";
import { agentCard, agentLabel } from "./agent-card";
import type { SceneAgent } from "./agents";
import { SCENE_H, SCENE_W } from "./floor";
import { AgentCardView, BayCardView, TicketTip } from "./pixel-cards";
import { PmTerminal } from "./pm-terminal";
import { bayCount } from "./repair-bay";
import { sceneSummary } from "./scene-model";
import { pct, type SceneTarget, sceneTargets } from "./targets";
import { useFloorScene, useSceneCanvas, useSceneSize } from "./use-floor";

/** Where the PM chat goes in pixel mode: docked beside the scene (wide screens) or over it. */
export interface PixelChat {
  docked: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const TERMINAL_W = 340;
const TAB_W = 32;

/** The hovered or focused target; a short delay before closing lets the pointer reach a card. */
function useHover() {
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef(0);
  const enter = useCallback((k: string) => {
    window.clearTimeout(timer.current);
    setKey(k);
  }, []);
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setKey(null), 200);
  }, []);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setKey(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Escape closes an open card.
  useEffect(() => {
    if (key === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, close]);
  return { key, enter, leave, close };
}

function targetLabel(t: SceneTarget, now: number): string {
  if (t.kind === "agent") return agentLabel(agentCard(t.agent, now));
  if (t.kind === "bay") {
    const n = t.crate.entries.length;
    return `Repair bay, ${t.crate.title}: ${n} ${n === 1 ? "item" : "items"}`;
  }
  return `${cardNumber(t.card.item)} ${t.card.item.title}, ${cardStateLabel(t.card)}`;
}

/**
 * Pixel mode (#209, #264): the factory floor on one small canvas, laid out as the pipeline runs.
 * Each agent sits at its station with its issue number and step above it; hovering or focusing
 * it shows what it is doing, and clicking it opens the item (the PM focuses its chat). Stopped
 * work waits in the repair bay. The PM's chat is a terminal docked beside its control room. The
 * canvas is decorative: transparent buttons carry the facts, and a live caption says what it
 * shows.
 */
export function PixelScene({
  f,
  pipeline,
  sessions,
  projectId,
  now,
  onOpen,
  chat,
}: {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  sessions: ReadonlyMap<string, SessionInfo>;
  projectId: string;
  now: number;
  onOpen: (card: ViewCard) => void;
  chat: PixelChat;
}) {
  const pm = useRoleSession("pm", projectId);
  const scene = useFloorScene({ f, pipeline, sessions, pmSessionId: pm?.id ?? null });
  const reduced = usePrefersReducedMotion();
  const canvas = useSceneCanvas(scene, reduced);
  const box = useRef<HTMLDivElement>(null);
  const reserve = chat.docked ? (chat.open ? TERMINAL_W : TAB_W) + 16 : 16;
  const scale = useSceneSize(box, reserve);
  const terminal = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const hover = useHover();
  const targets = useMemo(() => sceneTargets(scene), [scene]);
  const hovered = targets.find((t) => t.key === hover.key);

  const focusChat = () => {
    chat.setOpen(true);
    // After the terminal renders: its message box.
    window.setTimeout(() => terminal.current?.querySelector("textarea")?.focus(), 60);
  };
  const activate = (t: SceneTarget) => {
    if (t.kind === "ticket") return onOpen(t.card);
    if (t.kind === "bay") return hover.enter(t.key);
    const a: SceneAgent = t.agent;
    if (a.card) return onOpen(a.card);
    if (a.role === "pm") return focusChat();
    if (a.sessionId)
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: a.sessionId } });
  };
  const keep = () => hovered && hover.enter(hovered.key);
  const height = SCENE_H * scale;
  const terminalProps = { projectId, onFold: () => chat.setOpen(false), ref: terminal };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="factory-view-pixel-scene">
      <div ref={box} className="flex min-h-0 flex-1 items-center justify-center p-1">
        <div
          className={cn(
            "relative flex shrink-0 gap-1 rounded-sm bg-[#262b44] p-1 shadow-lg",
            scale === 0 && "invisible",
          )}
        >
          <div className="relative bg-[#1a1c2c]" style={{ width: SCENE_W * scale, height }}>
            <canvas
              ref={canvas}
              width={SCENE_W}
              height={SCENE_H}
              aria-hidden
              className="block size-full"
              style={{ imageRendering: "pixelated", willChange: "transform" }}
            />
            {targets.map((t) => (
              <button
                key={t.key}
                type="button"
                className="absolute cursor-pointer rounded-[2px] outline-none hover:ring-1 hover:ring-white/70 focus-visible:ring-2 focus-visible:ring-[#ffcd75]"
                style={pct(t.rect)}
                onClick={() => activate(t)}
                onMouseEnter={() => hover.enter(t.key)}
                onMouseLeave={hover.leave}
                onFocus={() => hover.enter(t.key)}
                onBlur={hover.leave}
                aria-label={targetLabel(t, now)}
                data-testid="factory-view-pixel-target"
                data-kind={t.kind}
              />
            ))}
            {hovered?.kind === "agent" && (
              <AgentCardView
                agent={hovered.agent}
                card={agentCard(hovered.agent, now)}
                anchor={hovered.rect}
                onEnter={keep}
                onLeave={hover.leave}
                onOpenItem={
                  hovered.agent.card
                    ? () => onOpen(hovered.agent.card as ViewCard)
                    : hovered.agent.role === "pm"
                      ? focusChat
                      : null
                }
              />
            )}
            {hovered?.kind === "bay" && (
              <BayCardView
                crate={hovered.crate}
                anchor={hovered.rect}
                projectId={projectId}
                onEnter={keep}
                onLeave={hover.leave}
                onOpen={onOpen}
              />
            )}
            {hovered?.kind === "ticket" && <TicketTip card={hovered.card} anchor={hovered.rect} />}
            {!chat.docked && chat.open && (
              <PmTerminal
                {...terminalProps}
                className="absolute inset-y-0 right-0 z-30 w-[min(360px,85%)]"
              />
            )}
          </div>
          {chat.docked &&
            (chat.open ? (
              <PmTerminal
                {...terminalProps}
                className="shrink-0"
                style={{ width: TERMINAL_W, height }}
              />
            ) : (
              <button
                type="button"
                onClick={focusChat}
                className="flex shrink-0 flex-col items-center gap-2 border-4 border-[#262b44] bg-[#29366f] py-2 font-mono text-[11px] text-[#f4f4f4] hover:bg-[#3b5dc9]"
                style={{ width: TAB_W, height }}
                aria-label="Show the PM chat"
                data-testid="factory-view-chat-show"
              >
                <span className="[writing-mode:vertical-rl]">PM TERMINAL</span>
              </button>
            ))}
        </div>
      </div>
      <p
        aria-live="polite"
        className="shrink-0 text-center text-2xs text-muted-foreground"
        data-testid="factory-view-pixel-summary"
        data-bay={bayCount(scene.bay)}
      >
        {sceneSummary(scene)}
      </p>
    </div>
  );
}
