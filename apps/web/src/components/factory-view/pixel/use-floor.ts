import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInputs } from "./agents";
import { drawScene } from "./draw";
import { SCENE_H, SCENE_W } from "./floor";
import { FloorMotion, stillFigures } from "./motion";
import { type Scene, sceneEvents, sceneOf } from "./scene-model";
import type { Seating } from "./seating";

/**
 * About 12 frames a second while someone walks or a moment plays; the idle animations (typing,
 * bubbles, the belt) only change every other frame, so those frames aren't painted at all.
 */
const FRAME_MS = 1000 / 12;

/**
 * The scene for the live state, its seats following the previous scene's, so agents keep their
 * desks across refreshes (the same data gives the same seats).
 */
export function useFloorScene(inputs: AgentInputs): Scene {
  const seating = useRef<Seating | null>(null);
  const { f, pipeline, sessions, pmSessionId } = inputs;
  return useMemo(() => {
    const scene = sceneOf({ f, pipeline, sessions, pmSessionId }, seating.current);
    seating.current = scene.seating;
    return scene;
  }, [f, pipeline, sessions, pmSessionId]);
}

/**
 * The scene's size on screen: as large as fits the box, less `reserve` pixels of width for the
 * docked PM terminal. When a whole number of device pixels per scene pixel loses little (under
 * 10%), it snaps to that, so every pixel is the same size.
 */
export function useSceneSize(box: RefObject<HTMLDivElement | null>, reserve: number) {
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const fit = Math.min((el.clientWidth - reserve) / SCENE_W, el.clientHeight / SCENE_H);
      const dpr = window.devicePixelRatio || 1;
      const snapped = Math.floor(fit * dpr) / dpr;
      setScale(Math.max(0.5, snapped >= 1 && snapped >= fit * 0.9 ? snapped : fit));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, reserve]);
  return scale;
}

/**
 * Draws frames at a fixed low rate while the tab is visible: a timer waits out the frame, then
 * `requestAnimationFrame` paints. Moments (walks, stamps, celebrations) start only when the
 * data changes. With reduced motion there is no loop and nobody walks: one still frame each
 * time the scene changes, with the same labels and status marks.
 */
export function useSceneCanvas(scene: Scene, reduced: boolean) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  const prev = useRef<Scene | null>(null);
  const tick = useRef(0);
  const motion = useRef(new FloorMotion());

  useEffect(() => {
    sceneRef.current = scene;
    const before = prev.current;
    prev.current = scene;
    if (reduced) {
      const ctx = canvas.current?.getContext("2d");
      if (ctx) drawScene(ctx, scene, stillFigures(scene), [], 0, false);
      return;
    }
    motion.current.play(scene, sceneEvents(before, scene), tick.current);
  }, [scene, reduced]);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    if (reduced) {
      motion.current = new FloorMotion();
      drawScene(ctx, sceneRef.current, stillFigures(sceneRef.current), [], 0, false);
      return;
    }
    let raf = 0;
    let timer = 0;
    const paint = () => {
      const m = motion.current;
      const s = sceneRef.current;
      drawScene(ctx, s, m.figures(s, tick.current), m.fx, tick.current, true);
    };
    const frame = (now: number) => {
      raf = 0;
      tick.current += 1;
      motion.current.advance(sceneRef.current, tick.current);
      if (motion.current.busy || tick.current % 2 === 0) paint();
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
    paint();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  return canvas;
}
