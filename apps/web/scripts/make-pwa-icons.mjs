// Renders the CodeDen mark (public/favicon.svg) into the web app manifest icons:
//   public/icons/icon-192.png, icon-512.png          rounded tile ("any")
//   public/icons/maskable-192.png, maskable-512.png  full-bleed, mark inside the safe zone
//   public/apple-touch-icon.png                      180px, full-bleed (iOS rounds it)
// Needs Playwright's Chromium (`pnpm --filter @codeden/web exec playwright install chromium`).
// Run with `pnpm --filter @codeden/web icons`; the outputs are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
/** The dark theme's `--background` token (oklch(0.165 0.008 264)). */
const BG = "#0d0e12";
const AMBER = "#f59e0b";

/** The mark in a 32-unit box (same path as public/favicon.svg). */
const mark = `
  <path d="M15.04 5.78L10.7 5.78A1.04 1.04 0 0 0 9.8 6.3L4.5 15.48A1.04 1.04 0 0 0 4.5 16.52L9.8 25.7A1.04 1.04 0 0 0 10.7 26.22L15.04 26.22L15.04 21.54L13.1 21.54A0.52 0.52 0 0 1 12.65 21.28L9.75 16.26A0.52 0.52 0 0 1 9.75 15.74L12.65 10.72A0.52 0.52 0 0 1 13.1 10.46L15.04 10.46ZM16.96 5.78L21.3 5.78A1.04 1.04 0 0 1 22.2 6.3L27.5 15.48A1.04 1.04 0 0 1 27.5 16.52L22.2 25.7A1.04 1.04 0 0 1 21.3 26.22L16.96 26.22ZM19.32 12.22A0.42 0.42 0 0 1 20.1 12.01L22.25 15.74A0.52 0.52 0 0 1 22.25 16.26L20.1 19.99A0.42 0.42 0 0 1 19.32 19.78Z" fill="${AMBER}" fill-rule="evenodd"/>`;

/** The mark on its rounded tile with transparent corners. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7.2" fill="${BG}"/>${mark}
</svg>`;

/** Full-bleed background; the mark scaled to `scale` of the side, centred. */
const fullBleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BG}"/>
  <g transform="translate(${16 - 16 * scale} ${16 - 16 * scale}) scale(${scale})">${mark}</g>
</svg>`;

const outputs = [
  ["public/icons/icon-192.png", tile, 192],
  ["public/icons/icon-512.png", tile, 512],
  // Maskable icons are cropped to a circle of 80% of the side: keep the mark well inside it.
  ["public/icons/maskable-192.png", fullBleed(0.72), 192],
  ["public/icons/maskable-512.png", fullBleed(0.72), 512],
  ["public/apple-touch-icon.png", fullBleed(0.8), 180],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, svg, size] of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace(
        "<svg ",
        `<svg width="${size}" height="${size}" `,
      )}</body></html>`,
    );
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    const out = resolve(root, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, png);
    console.log(`wrote ${file} (${size}px)`);
  }
} finally {
  await browser.close();
}
