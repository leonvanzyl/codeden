/**
 * Pixel mode's 5-pixel-high font, drawn by hand for CodeDen: the wall signs, the agents' labels,
 * the counters and the "+N" signs. Glyphs are 3 pixels wide (a few are wider where 3 can't read),
 * a pixel apart. Text is painted once into a small canvas per colour and reused.
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
  "-": "000000111000000",
  "!": "010010010000010",
  "?": "111001011000010",
  ":": "000010000010000",
  ".": "000000000000010",
  "#": "0101011111010101111101010",
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "1000111011101011000110001",
  N: "10011101101110011001",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101110011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "1000110001101011010101010",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
};

const glyphWidth = (ch: string) => (GLYPHS[ch]?.length ?? 15) / 5;

/** The width of text in the pixel font. */
export function textWidth(text: string, scale = 1): number {
  if (text.length === 0) return 0;
  return ([...text].reduce((w, ch) => w + glyphWidth(ch) + 1, 0) - 1) * scale;
}

/** Draws text in the pixel font at (x, y). Unknown characters leave a gap. */
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
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch];
    const width = glyphWidth(ch);
    if (glyph)
      for (let i = 0; i < glyph.length; i++)
        if (glyph[i] === "1")
          ctx.fillRect(cx + (i % width) * scale, y + Math.floor(i / width) * scale, scale, scale);
    cx += (width + 1) * scale;
  }
}

/** Text with a one-pixel dark shadow, for signs over a busy floor. */
export function shadowText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
  scale = 1,
) {
  pixelText(ctx, text, x + 1, y + 1, "#1a1c2c", scale);
  pixelText(ctx, text, x, y, colour, scale);
}
