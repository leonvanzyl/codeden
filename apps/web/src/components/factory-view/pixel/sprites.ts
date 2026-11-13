/**
 * The pixel mode's art: small palette-indexed sprites, drawn by hand for CodeDen (original art,
 * no third-party assets). Each row is a string; each character is a palette key and `.` is
 * transparent. A sprite is painted once into a small offscreen canvas per colour variant, and
 * the scene then only copies it with `drawImage`.
 */

/** The base palette: a muted 16-bit set. */
const PALETTE: Record<string, string> = {
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
  // Swapped per variant: hat or hair (H, h), clothes (B, b), and one tint (X).
  H: "#ffcd75",
  h: "#ef7d57",
  B: "#3b5dc9",
  b: "#29366f",
  X: "#e43b44",
};

/** Colour swaps: worker roles and the tint of flags, lamps, bubbles and tickets. */
const VARIANTS: Record<string, Record<string, string>> = {
  base: {},
  // A yellow hard hat and blue overalls.
  builder: {},
  // Brown hair and a green vest.
  reviewer: { H: "#6b3e26", h: "#4a2a1a", B: "#38b764", b: "#257179" },
  // A tan cap and a rust coat.
  scout: { H: "#c28a52", h: "#6e4527", B: "#b86f50", b: "#7a3f2c" },
  // A purple beanie.
  helper: { H: "#b55dd0", h: "#6d2f8a", B: "#7f6bd6", b: "#4f3f99" },
  red: { X: "#e43b44" },
  redDim: { X: "#7a2232" },
  amber: { X: "#ffb000" },
  amberDim: { X: "#8a5d12" },
  paper: { X: "#fff8e7" },
  bug: { X: "#e43b44" },
  feature: { X: "#41a6f6" },
  docs: { X: "#38b764" },
  // Sealed with green tape.
  shipped: { t: "#d9a066", u: "#b77b45", T: "#38b764" },
  // The machine's screen shows red when it failed.
  broken: { d: "#7a2232" },
};

export type SpriteVariant = keyof typeof VARIANTS;

const rep = (ch: string, n: number) => ch.repeat(n);

// Workers are 10×14, facing the viewer.
const HEAD = [
  "...kkkk...",
  "..kHHHHk..",
  ".kHHHHHHk.",
  ".khhhhhhk.",
  "..kssssk..",
  "..kksskk..",
  "..kssssk..",
  "...kkkk...",
];
const BODY = ["..kBBBBk..", ".kBBBBBBk.", ".ksBBBBsk.", "..kbbbbk.."];

const SPRITES = {
  stand: [...HEAD, ...BODY, "..kLkkLk..", "..kk..kk.."],
  // The right arm up, ready to strike.
  armUp: [
    "...kkkk...",
    "..kHHHHk..",
    ".kHHHHHHk.",
    ".khhhhhhkk",
    "..kssssksk",
    "..kksskkBk",
    "..kssssBk.",
    "...kkkkBk.",
    "..kBBBBBk.",
    ".kBBBBBk..",
    ".ksBBBBk..",
    "..kbbbbk..",
    "..kLkkLk..",
    "..kk..kk..",
  ],
  // The right arm down on the bench.
  armDown: [
    ...HEAD,
    "..kBBBBk..",
    ".kBBBBBBk.",
    ".ksBBBBBBk",
    "..kbbbbksk",
    "..kLkkLk..",
    "..kk..kk..",
  ],
  walkA: [...HEAD, ...BODY, "..kLkkLk..", ".kk....kk."],
  walkB: [...HEAD, ...BODY, "...kLLk...", "...kkkk..."],
  // Sitting on the floor with closed eyes: the loop is stopped.
  sit: [
    "..........",
    "..........",
    "...kkkk...",
    "..kHHHHk..",
    ".kHHHHHHk.",
    ".khhhhhhk.",
    "..kssssk..",
    "..kkkkkk..",
    "..kssssk..",
    "...kkkk...",
    "..kBBBBk..",
    ".ksBBBBsk.",
    ".kLLLLLLk.",
    ".kkkkkkkk.",
  ],
  hammerUp: ["GgG", ".T.", ".T.", ".T."],
  hammerDown: ["TTGG", "..GG"],
  clipboard: [".kGk.", "kTTTk", "kwwwk", "kwPwk", "kwwwk", "kkkkk"],
  magnifier: [".kk..", "kcwk.", "kcck.", ".kkT.", "...T."],
  notepad: ["kkkk", "kyyk", "kPPk", "kyyk", "kkkk"],
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
  // A workbench, 22×10: the top, the front, the legs.
  bench: [
    rep("k", 22),
    `k${rep("t", 20)}k`,
    `kt${rep("g", 3)}${rep("t", 12)}${rep("G", 2)}ttk`,
    `k${rep("t", 20)}k`,
    rep("k", 22),
    `k${rep("u", 20)}k`,
    `k${rep("T", 20)}k`,
    rep("k", 22),
    `.kTk${rep(".", 14)}kTk.`,
    `.kkk${rep(".", 14)}kkk.`,
  ],
  // A machine, 18×16: the top, a screen, vents, buttons.
  machine: [
    `..${rep("k", 14)}..`,
    `..k${rep("m", 12)}k..`,
    `..k${rep("m", 12)}k..`,
    `..k${rep("m", 12)}k..`,
    rep("k", 18),
    `k${rep("M", 16)}k`,
    "kMkkkkkkkMMMgggMMk",
    "kMkdddddkMMMMMMMMk",
    "kMkdddddkMMMgggMMk",
    "kMkkkkkkkMMMMMMMMk",
    "kMMMMMMMMMMMgggMMk",
    "kMMoMMrMMMMMMMMMMk",
    `k${rep("M", 16)}k`,
    `k${rep("G", 16)}k`,
    rep("k", 18),
    `.kk${rep(".", 12)}kk.`,
  ],
  lamp: [".kk.", "kXXk", "kXXk", "kkkk"],
  // A pennant with a "!" on a pole, in two frames so it flutters.
  flagA: [
    "kkkkk...",
    "kXXwXk..",
    "kXXwXXk.",
    "kXXXXk..",
    "kkkkk...",
    "k.......",
    "k.......",
    "k.......",
    "kk......",
  ],
  flagB: [
    "kkkk....",
    "kXXwk...",
    "kXXwXk..",
    "kXXXXXk.",
    "kkkkkk..",
    "k.......",
    "k.......",
    "k.......",
    "kk......",
  ],
  question: [
    ".kkkkk.",
    "kwkkkwk",
    "kwwwkwk",
    "kwwkkwk",
    "kwwwwwk",
    "kwwkwwk",
    ".kkkkk.",
    "..kk...",
  ],
  bang: [".kkkkk.", "kXXwXXk", "kXXwXXk", "kXXwXXk", "kXXXXXk", "kXXwXXk", ".kkkkk.", "..kk..."],
  check: ["....n", "...n.", "n.n..", ".n..."],
  smoke: [".GG..", "GggG.", "GgggG", ".GGG."],
  sparkleA: ["..y..", "..y..", "yywyy", "..y..", "..y.."],
  sparkleB: [".....", "..y..", ".ywy.", "..y..", "....."],
} satisfies Record<string, string[]>;

export type SpriteName = keyof typeof SPRITES;

const cache = new Map<string, HTMLCanvasElement>();

/** A sprite painted in a variant's colours, made once and reused. */
export function sprite(name: SpriteName, variant: SpriteVariant = "base"): HTMLCanvasElement {
  const key = `${name}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = SPRITES[name];
  const width = Math.max(...rows.map((r) => r.length));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const colours = { ...PALETTE, ...VARIANTS[variant] };
    rows.forEach((row, y) => {
      [...row].forEach((key, x) => {
        const colour = colours[key];
        if (!colour) return;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
      });
    });
  }
  cache.set(key, canvas);
  return canvas;
}

/**
 * A 5-pixel-high font for the counter board, the "+N" signs and the door signs. Glyphs are
 * 3 wide, except N (4), which can't read as an N in 3.
 */
const GLYPHS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001111",
  "+": "000010111010000",
  I: "111010010010111",
  N: "10011101101110011001",
  S: "111100111001111",
  H: "101101111101101",
  P: "111101111100100",
};

const glyphWidth = (ch: string) => (GLYPHS[ch]?.length ?? 15) / 5;

/** The width of text in the pixel font, a pixel between letters. */
export function pixelTextWidth(text: string, scale = 1): number {
  return ([...text].reduce((w, ch) => w + glyphWidth(ch) + 1, 0) - 1) * scale;
}

/** Draws text in the pixel font. Unknown characters leave a gap. */
export function pixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
  scale = 1,
) {
  ctx.fillStyle = colour;
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    const width = glyphWidth(ch);
    if (glyph)
      [...glyph].forEach((bit, i) => {
        if (bit === "1")
          ctx.fillRect(cx + (i % width) * scale, y + Math.floor(i / width) * scale, scale, scale);
      });
    cx += (width + 1) * scale;
  }
}
