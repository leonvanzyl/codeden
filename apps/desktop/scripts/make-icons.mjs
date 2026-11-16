// Renders the CodeDen mark (apps/web/public/favicon.svg) into the desktop app's icons:
//   build/icon.png              1024px app icon (electron-builder derives .ico/.icns from it)
//   assets/tray.png, @2x        Windows and Linux tray icon (the full-colour mark)
//   assets/trayTemplate.png, @2x  macOS menu bar template (black on transparent)
//   assets/badge.png            Windows taskbar overlay for "something is waiting"
//   assets/icon.png             256px window icon (Linux)
// Needs Playwright's Chromium (`pnpm --filter @codeden/web exec playwright install chromium`).
// Run with `pnpm --filter @codeden/desktop icons`; the outputs are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const BG = "#0f1115";
const AMBER = "#f59e0b";
/** The mark in a 32-unit box (same path as apps/web/public/favicon.svg). */
const MARK =
  "M15.04 5.78L10.7 5.78A1.04 1.04 0 0 0 9.8 6.3L4.5 15.48A1.04 1.04 0 0 0 4.5 16.52L9.8 25.7A1.04 1.04 0 0 0 10.7 26.22L15.04 26.22L15.04 21.54L13.1 21.54A0.52 0.52 0 0 1 12.65 21.28L9.75 16.26A0.52 0.52 0 0 1 9.75 15.74L12.65 10.72A0.52 0.52 0 0 1 13.1 10.46L15.04 10.46ZM16.96 5.78L21.3 5.78A1.04 1.04 0 0 1 22.2 6.3L27.5 15.48A1.04 1.04 0 0 1 27.5 16.52L22.2 25.7A1.04 1.04 0 0 1 21.3 26.22L16.96 26.22ZM19.32 12.22A0.42 0.42 0 0 1 20.1 12.01L22.25 15.74A0.52 0.52 0 0 1 22.25 16.26L20.1 19.99A0.42 0.42 0 0 1 19.32 19.78Z";

/** The mark on its rounded tile, inset so it sits well next to other app icons. */
const appIcon = (inset) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g transform="translate(${inset} ${inset}) scale(${(32 - inset * 2) / 32})">
    <rect width="32" height="32" rx="7.2" fill="${BG}"/>
    <path d="${MARK}" fill="${AMBER}" fill-rule="evenodd"/>
  </g>
</svg>`;

/** The mark alone, cropped to its bounds, for small tray sizes (a tile would read as a blob at 16px). */
const glyph = (color) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 24 24">
  <path d="${MARK}" fill="${color}" fill-rule="evenodd"/>
</svg>`;

const badge = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="7" fill="${AMBER}" stroke="${BG}" stroke-width="1.5"/>
</svg>`;

const outputs = [
  ["build/icon.png", appIcon(2.6), 1024],
  ["assets/icon.png", appIcon(1.2), 256],
  ["assets/tray.png", glyph(AMBER), 16],
  ["assets/tray@2x.png", glyph(AMBER), 32],
  ["assets/trayTemplate.png", glyph("#000000"), 16],
  ["assets/trayTemplate@2x.png", glyph("#000000"), 32],
  ["assets/badge.png", badge, 16],
  ["assets/badge@2x.png", badge, 32],
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
