import { useState } from "react";
import { useRoomy } from "../hooks";

const MODE_KEY = "codeden.factoryView.mode";

export interface PixelMode {
  /** The toggle is offered: tablets and up. On phones the view always shows the board. */
  available: boolean;
  /** The scene shows instead of the board. */
  on: boolean;
  set: (on: boolean) => void;
}

/**
 * The Factory view's pixel mode (#209): off by default and remembered per browser. Hidden
 * below 640 px, where a 16:9 scene leaves workers too small to tap.
 */
export function usePixelMode(): PixelMode {
  const available = useRoomy();
  const [pixel, setPixel] = useState(() => localStorage.getItem(MODE_KEY) === "pixel");
  return {
    available,
    on: available && pixel,
    set: (next) => {
      localStorage.setItem(MODE_KEY, next ? "pixel" : "board");
      setPixel(next);
    },
  };
}
