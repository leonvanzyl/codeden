/**
 * The pixel mode's props: small palette-indexed sprites drawn by hand for CodeDen (original art,
 * no third-party assets). Each row is a string; each character is a palette key and `.` is
 * transparent. A sprite is painted once into a small offscreen canvas per colour set, and the
 * scene then only copies it with `drawImage`. People are in `people.ts`.
 */

/** The base palette: a muted 16-bit set. */
export const PALETTE: Record<string, string> = {
  k: "#1a1c2c", // outline
  s: "#f4c39b", // skin
  L: "#333c57", // trousers
  w: "#f4f4f4",
  g: "#94b0c2",
  G: "#566c86",
  d: "#29366f", // screen
  t: "#c28a52", // light wood
  u: "#a0683a", // wood
  T: "#6e4527", // dark wood
  m: "#8da1b3", // metal
  M: "#5d6f84", // dark metal
  c: "#73eff7", // glass
  p: "#fff8e7", // paper
  P: "#b8b9c4", // paper lines
  y: "#ffcd75",
  n: "#38b764",
  r: "#e43b44",
  o: "#ef7d57",
  b: "#41a6f6",
  X: "#e43b44", // swapped per variant
};

export const INK = "#1a1c2c";

/** Colour swaps for props: flags, lamps, tickets, crates. */
const VARIANTS: Record<string, Record<string, string>> = {
  base: {},
  red: { X: "#e43b44" },
  amber: { X: "#ffb000" },
  green: { X: "#38b764" },
  blue: { X: "#41a6f6" },
  dim: { X: "#3d4660" },
  paper: { X: "#fff8e7" },
  bug: { X: "#e43b44" },
  feature: { X: "#41a6f6" },
  docs: { X: "#38b764" },
  // Stamped and sealed with green tape.
  stamped: { t: "#d9a066", u: "#b77b45", T: "#38b764" },
};

export type PropVariant = keyof typeof VARIANTS;

const cache = new Map<string, HTMLCanvasElement>();

/**
 * Paints rows of palette keys once and reuses the canvas. `make` builds the rows and colours,
 * and only runs the first time: a frame only looks sprites up.
 */
export function paint(
  key: string,
  make: () => { rows: readonly string[]; colours: Record<string, string> },
): HTMLCanvasElement {
  const hit = cache.get(key);
  if (hit) return hit;
  const { rows, colours } = make();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, ...rows.map((r) => r.length));
  canvas.height = Math.max(1, rows.length);
  const ctx = canvas.getContext("2d");
  if (ctx)
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const colour = colours[row[x] as string];
        if (!colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  cache.set(key, canvas);
  return canvas;
}

/** Paints into a cached canvas with a drawing function (labels, counters). */
export function painted(
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  // Labels change with the data: keep the cache from growing without bound.
  if (cache.size > 600) cache.clear();
  cache.set(key, canvas);
  return canvas;
}

const rep = (ch: string, n: number) => ch.repeat(n);

const PROPS = {
  ticket: ["kkkkkkk", "kXXXXXk", "kpPPPpk", "kpPPppk", "kkkkkkk"],
  crate: [
    rep("k", 12),
    `k${rep("t", 10)}k`,
    `k${rep("t", 10)}k`,
    rep("k", 12),
    "kuTuuuuuuTuk",
    "kuuTuuuuTuuk",
    "kuuuTuuTuuuk",
    "kuuuuTTuuuuk",
    "kuuuTuuTuuuk",
    "kuuTuuuuTuuk",
    "kuTuuuuuuTuk",
    rep("k", 12),
  ],
  smallCrate: ["kkkkkkkk", "kttttttk", "kkkkkkkk", "kuTuuTuk", "kuuTTuuk", "kuTuuTuk", "kkkkkkkk"],
  // A desk seen from the front, 24×14: the top at the sitter's waist, a panel, legs.
  deskPrep: [
    `....${rep("k", 8)}${rep(".", 12)}`,
    `....kMMMMMMk..kkkkk.....`,
    `....kMMMMMMk..kpPpk.....`,
    rep("k", 24),
    `k${rep("t", 22)}k`,
    `k${rep("t", 22)}k`,
    rep("k", 24),
    `k${rep("u", 22)}k`,
    `ku${rep("T", 8)}u${rep("u", 4)}u${rep("T", 6)}uk`,
    `k${rep("u", 22)}k`,
    rep("k", 24),
    `.kTk${rep(".", 16)}kTk.`,
    `.kTk${rep(".", 16)}kTk.`,
    `.kkk${rep(".", 16)}kkk.`,
  ],
  deskBench: [
    `..kk${rep(".", 14)}.kk...`,
    `..kGk.kyk${rep(".", 9)}kGGk..`,
    `..kGk.kyk${rep(".", 9)}kGGk..`,
    rep("k", 24),
    `k${rep("t", 22)}k`,
    `kt${rep("g", 3)}${rep("t", 14)}${rep("G", 2)}ttk`,
    rep("k", 24),
    `k${rep("T", 22)}k`,
    `k${rep("T", 22)}k`,
    rep("k", 24),
    `.kTk${rep(".", 16)}kTk.`,
    `.kTk${rep(".", 16)}kTk.`,
    `.kTk${rep(".", 16)}kTk.`,
    `.kkk${rep(".", 16)}kkk.`,
  ],
  deskReview: [
    `${rep(".", 17)}kkk....`,
    `${rep(".", 16)}kyyyk...`,
    `${rep(".", 17)}.k.....`.slice(0, 24),
    rep("k", 24),
    `k${rep("g", 22)}k`,
    `k${rep("g", 22)}k`,
    rep("k", 24),
    `k${rep("G", 22)}k`,
    `kG${rep("M", 20)}Gk`,
    `k${rep("G", 22)}k`,
    rep("k", 24),
    `.kMk${rep(".", 16)}kMk.`,
    `.kMk${rep(".", 16)}kMk.`,
    `.kkk${rep(".", 16)}kkk.`,
  ],
  // The PM's console: two screens facing the room, a desk.
  console: [
    `.${rep("k", 9)}..${rep("k", 9)}...`.slice(0, 24),
    `.kdddddddk..kdddddddk...`,
    `.kdcdcddck..kdddcdcdk...`,
    rep("k", 24),
    `k${rep("M", 22)}k`,
    `kM${rep("G", 4)}MyMnMrM${rep("G", 8)}MMMk`.slice(0, 24),
    rep("k", 24),
    `k${rep("M", 22)}k`,
    `k${rep("M", 22)}k`,
    rep("k", 24),
    `.kMk${rep(".", 16)}kMk.`,
    `.kMk${rep(".", 16)}kMk.`,
    `.kMk${rep(".", 16)}kMk.`,
    `.kkk${rep(".", 16)}kkk.`,
  ],
  lamp: [".kk.", "kXXk", "kXXk", "kkkk"],
  // Bubbles above a head.
  thought: [".kkkkkk.", "kwwwwwwk", "kwkwkwwk", "kwwwwwwk", ".kkkkkk.", "..kk....", "...k...."],
  bang: [".kkkkk.", "kyykyyk", "kyykyyk", "kyykyyk", "kyyyyyk", "kyykyyk", ".kkkkk.", "...k..."],
  sweat: ["..b..", ".bbb.", "bbwbb", "bbbbb", ".bbb."],
  sweatRed: ["..r..", ".rrr.", "rrwrr", "rrrrr", ".rrr."],
  check: ["....n", "...n.", "n.n..", ".n..."],
  smoke: [".GG..", "GggG.", "GgggG", ".GGG."],
  poof: [".w.w.", "wwgww", ".www.", "wwgww", ".w.w."],
  sparkleA: ["..y..", "..y..", "yywyy", "..y..", "..y.."],
  sparkleB: [".....", "..y..", ".ywy.", "..y..", "....."],
  stamp: [".kk.", ".kk.", "kXXk", "kkkk"],
  // Held items, drawn over a person.
  clipboard: [".kGk.", "kTTTk", "kwwwk", "kwPwk", "kwwwk", "kkkkk"],
  magnifier: [".kk..", "kcwk.", "kcck.", ".kkT.", "...T."],
  wrench: ["m.m", "mmm", ".m.", ".m.", ".m."],
  notepad: ["kkkk", "kyyk", "kPPk", "kyyk", "kkkk"],
} satisfies Record<string, string[]>;

export type PropName = keyof typeof PROPS;

export function prop(name: PropName, variant: PropVariant = "base"): HTMLCanvasElement {
  return paint(`prop:${name}:${variant}`, () => ({
    rows: PROPS[name],
    colours: { ...PALETTE, ...VARIANTS[variant] },
  }));
}

/**
 * 5×5 step glyphs for the agents' labels: what each step looks like at a glance (a bug under a
 * lens, a light bulb, a hammer, two turning arrows, a check, a wrench, an arrow to the door, an
 * eye on CI), plus the roles without an item.
 */
export const STEP_GLYPHS = {
  reproducing: ["10101", "01110", "11111", "01110", "10101"],
  analyzing: ["01110", "10001", "01110", "00100", "01110"],
  implementing: ["11110", "11110", "00100", "00100", "00100"],
  revising: ["01101", "10011", "10111", "10000", "01110"],
  reviewing: ["00000", "00001", "00010", "10100", "01000"],
  rebasing: ["01010", "01110", "00100", "00100", "00100"],
  merging: ["00100", "01110", "10101", "00100", "00100"],
  watching_ci: ["00000", "01110", "11011", "01110", "00000"],
  pm: ["01110", "10001", "10001", "11011", "00010"],
  scout: ["11000", "11100", "01110", "00111", "00011"],
  area: ["01100", "10010", "10010", "01110", "00011"],
} satisfies Record<string, string[]>;

export type GlyphName = keyof typeof STEP_GLYPHS;

/** Draws a 5×5 glyph at (x, y). */
export function glyph(
  ctx: CanvasRenderingContext2D,
  name: GlyphName,
  x: number,
  y: number,
  colour: string,
) {
  ctx.fillStyle = colour;
  STEP_GLYPHS[name].forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) if (row[dx] === "1") ctx.fillRect(x + dx, y + dy, 1, 1);
  });
}
