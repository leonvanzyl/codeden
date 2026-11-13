import type { FactoryStatus } from "@codeden/contracts";
import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { cardNumber, cardStateLabel, type ViewCard, type ViewPipeline } from "../stages";
import { drawScene, EFFECT_FRAMES, type SceneEffect } from "./draw";
import { type Rect, SCENE_H, SCENE_W, type SceneTarget, sceneTargets } from "./layout";
import { type Scene, sceneEvents, sceneOf, sceneSummary } from "./scene-model";

/** About 12 frames a second: lively enough, and cheap. */
const FRAME_MS = 1000 / 12;

/**
 * The scene's size on screen: as large as fits. When a whole number of device pixels per scene
 * pixel loses little (under 10%), it snaps to that, so every pixel is the same size.
 */
function useSceneSize(box: RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const fit = Math.min(el.clientWidth / SCENE_W, el.clientHeight / SCENE_H);
      const dpr = window.devicePixelRatio || 1;
      const snapped = Math.floor(fit * dpr) / dpr;
      setScale(snapped >= 1 && snapped >= fit * 0.9 ? snapped : fit);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return scale;
}

/**
 * Draws frames at a fixed low rate while the tab is visible: a timer waits out the frame, then
 * `requestAnimationFrame` paints. With reduced motion there is no loop, just a still frame each
 * time the scene changes.
 */
function useSceneCanvas(scene: Scene, reduced: boolean) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  const prev = useRef<Scene | null>(null);
  const tick = useRef(0);
  const effects = useRef<SceneEffect[]>([]);

  useEffect(() => {
    sceneRef.current = scene;
    const before = prev.current;
    prev.current = scene;
    if (reduced) {
      const ctx = canvas.current?.getContext("2d");
      if (ctx) drawScene(ctx, scene, 0, [], false);
      return;
    }
    const events = sceneEvents(before, scene);
    for (const id of events.buildStarted) {
      const b = scene.builders.items.find((x) => x.card.item.id === id);
      if (b) effects.current.push({ kind: "carry", slot: b.slot, start: tick.current });
    }
    if (events.shipped.length > 0)
      effects.current.push({ kind: "ship", slot: 0, start: tick.current });
  }, [scene, reduced]);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    if (reduced) {
      drawScene(ctx, sceneRef.current, 0, [], false);
      return;
    }
    let raf = 0;
    let timer = 0;
    const frame = (now: number) => {
      raf = 0;
      tick.current += 1;
      effects.current = effects.current.filter(
        (e) => tick.current - e.start < EFFECT_FRAMES[e.kind],
      );
      drawScene(ctx, sceneRef.current, tick.current, effects.current, true);
      // Wait out the rest of the frame; the animation frame then lands on the next vsync.
      const spent = performance.now() - now;
      timer = window.setTimeout(schedule, Math.max(0, FRAME_MS - spent - 8));
    };
    const schedule = () => {
      timer = 0;
      if (document.visibilityState === "visible") raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = 0;
    };
    const onVisibility = () => {
      stop();
      if (document.visibilityState === "visible") schedule();
    };
    drawScene(ctx, sceneRef.current, tick.current, effects.current, true);
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  return canvas;
}

const pct = (r: Rect): CSSProperties => ({
  left: `${(r.x / SCENE_W) * 100}%`,
  top: `${(r.y / SCENE_H) * 100}%`,
  width: `${(r.w / SCENE_W) * 100}%`,
  height: `${(r.h / SCENE_H) * 100}%`,
});

/** The scout's corner, where hovering tells how its round goes. */
const SCOUT_CORNER: Rect = { x: 3, y: 116, w: 50, h: 60 };

interface Tip {
  rect: Rect;
  title: string;
  detail?: string;
  /** A speech bubble: the builder's latest progress line. */
  speech?: string;
}

function tipFor(target: SceneTarget): Tip {
  const w = target.card.item;
  return {
    rect: target.rect,
    title: `${cardNumber(w)} ${w.title}`,
    detail: cardStateLabel(target.card),
    speech: target.kind === "builder" ? target.card.activity : undefined,
  };
}

function scoutTip(scene: Scene): Tip | null {
  const s = scene.scout;
  if (!s) return null;
  const phase = s.walking
    ? `round ${s.round}: ${s.findings} found, ${s.filed} filed`
    : "between rounds";
  const helpers = s.helpers.map((h) => `${h.label} (${h.state})`).join(", ");
  return {
    rect: SCOUT_CORNER,
    title: `Scout, ${phase}`,
    detail: helpers ? `Area reviewers: ${helpers}` : undefined,
  };
}

function Tooltip({ tip }: { tip: Tip }) {
  // Below the thing when it's near the top; anchored to its side near the left and right edges.
  const below = tip.rect.y < 60;
  const centre = tip.rect.x + tip.rect.w / 2;
  const align = centre < 70 ? "left" : centre > SCENE_W - 70 ? "right" : "centre";
  const x = align === "left" ? tip.rect.x : align === "right" ? tip.rect.x + tip.rect.w : centre;
  const shiftX = align === "left" ? "0" : align === "right" ? "-100%" : "-50%";
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-max max-w-64 border-2 border-[#1a1c2c] bg-[#fff8e7] px-1.5 py-1 font-mono text-[11px] leading-snug text-[#1a1c2c] shadow-[2px_2px_0_#1a1c2c]"
      style={{
        left: `${(x / SCENE_W) * 100}%`,
        top: below
          ? `calc(${((tip.rect.y + tip.rect.h) / SCENE_H) * 100}% + 4px)`
          : `calc(${(tip.rect.y / SCENE_H) * 100}% - 4px)`,
        transform: `translate(${shiftX}, ${below ? "0" : "-100%"})`,
      }}
      data-testid="factory-view-pixel-tip"
    >
      <div className="font-semibold">{tip.title}</div>
      {tip.detail && <div className="text-[#566c86]">{tip.detail}</div>}
      {tip.speech && (
        <div className="mt-1 rounded-sm border border-[#1a1c2c] bg-white px-1 italic">
          “{tip.speech}”
        </div>
      )}
    </div>
  );
}

/**
 * Pixel mode (#209): the factory floor drawn on one small canvas. The workers, tickets, crates
 * and machines stand for the board's cards; each has a transparent button over it that opens
 * the same side sheet. The canvas is decorative: a live caption says what it shows.
 */
export function PixelScene({
  f,
  pipeline,
  onOpen,
}: {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  onOpen: (card: ViewCard) => void;
}) {
  const scene = useMemo(() => sceneOf(f, pipeline), [f, pipeline]);
  const reduced = usePrefersReducedMotion();
  const canvas = useSceneCanvas(scene, reduced);
  const box = useRef<HTMLDivElement>(null);
  const scale = useSceneSize(box);
  const targets = useMemo(() => sceneTargets(scene), [scene]);
  const [hover, setHover] = useState<string | null>(null);
  const hovered = targets.find((t) => t.key === hover);
  const tip = hover === "scout" ? scoutTip(scene) : hovered ? tipFor(hovered) : null;
  const summary = sceneSummary(scene);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="factory-view-pixel-scene">
      <div ref={box} className="flex min-h-0 flex-1 items-center justify-center p-1">
        <div
          className={cn(
            "relative shrink-0 rounded-sm bg-[#1a1c2c] shadow-lg ring-4 ring-[#262b44]",
            scale === 0 && "invisible",
          )}
          style={{ width: SCENE_W * scale, height: SCENE_H * scale }}
        >
          <canvas
            ref={canvas}
            width={SCENE_W}
            height={SCENE_H}
            aria-hidden
            className="block size-full"
            style={{ imageRendering: "pixelated" }}
          />
          {scene.scout && (
            <div
              aria-hidden
              className="absolute"
              style={pct(SCOUT_CORNER)}
              onMouseEnter={() => setHover("scout")}
              onMouseLeave={() => setHover(null)}
            />
          )}
          {targets.map((t) => (
            <button
              key={t.key}
              type="button"
              className="absolute cursor-pointer rounded-[2px] outline-none hover:ring-1 hover:ring-white/70 focus-visible:ring-2 focus-visible:ring-[#ffcd75]"
              style={pct(t.rect)}
              onClick={() => onOpen(t.card)}
              onMouseEnter={() => setHover(t.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(t.key)}
              onBlur={() => setHover(null)}
              aria-label={`${cardNumber(t.card.item)} ${t.card.item.title}, ${cardStateLabel(t.card)}`}
              data-testid="factory-view-pixel-target"
              data-kind={t.kind}
            />
          ))}
          {tip && <Tooltip tip={tip} />}
        </div>
      </div>
      <p
        aria-live="polite"
        className="shrink-0 text-center text-2xs text-muted-foreground"
        data-testid="factory-view-pixel-summary"
      >
        {summary}
      </p>
    </div>
  );
}
