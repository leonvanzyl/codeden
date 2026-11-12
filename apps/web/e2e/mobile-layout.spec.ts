import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Phone and tablet smoke (§13): the main screens fit without horizontal scroll at 390x844,
 * 820x1180 and 1180x820 on a touch screen, the sidebar is a drawer (or a rail in landscape)
 * and the right panel opens as a sheet.
 */
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`global setup did not set ${name}`);
  return value;
};

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(`${env("CODEDEN_E2E_URL")}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env("CODEDEN_E2E_TOKEN")}` },
    data: body,
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function projectId(page: Page): Promise<string> {
  const repo = env("CODEDEN_E2E_REPO");
  const snap = await api<{ projects: { id: string; path: string }[] }>(page, "GET", "/snapshot");
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  const found = snap.projects.find((p) => norm(p.path) === norm(repo));
  if (found) return found.id;
  const created = await api<{ project: { id: string } }>(page, "POST", "/projects", {
    source: { type: "local", path: repo },
  });
  return created.project.id;
}

/** No page-level horizontal scroll. */
async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label} scrolls sideways`).toBeLessThanOrEqual(0);
}

const SIZES = [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, nav: "drawer" },
  {
    name: "tablet portrait",
    viewport: { width: 820, height: 1180 },
    isMobile: false,
    nav: "drawer",
  },
  {
    name: "tablet landscape",
    viewport: { width: 1180, height: 820 },
    isMobile: false,
    nav: "rail",
  },
] as const;

async function openContext(browser: Browser, size: (typeof SIZES)[number]) {
  const context = await browser.newContext({
    viewport: size.viewport,
    isMobile: size.isMobile,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  return { context, page };
}

let project = "";
let sessionId = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await api(page, "POST", "/setup/complete", {});
  project = await projectId(page);
  const started = await api<{ status: string; sessionId: string }>(page, "POST", "/sessions", {
    projectId: project,
    provider: "fake",
    purpose: "Mobile layout smoke",
    input: { text: "Say hello from the phone" },
  });
  expect(started.status).toBe("started");
  sessionId = started.sessionId;
  await page.close();
});

for (const size of SIZES) {
  test(`main screens fit a ${size.name} (${size.viewport.width}x${size.viewport.height})`, async ({
    browser,
  }) => {
    const { context, page } = await openContext(browser, size);
    try {
      const screens: [string, string][] = [
        ["orchestrator", "/"],
        ["session", `/sessions/${sessionId}`],
        ["inbox", "/inbox"],
        ["project home", `/projects/${project}`],
        ["automations", `/projects/${project}/automations`],
        ["settings", "/settings/network"],
      ];
      for (const [label, path] of screens) {
        await page.goto(`${env("CODEDEN_E2E_URL")}${path}`);
        await page.locator("main").waitFor();
        await page.waitForTimeout(300);
        await expectNoHorizontalScroll(page, label);
      }

      // Navigation: a drawer from the menu button, or the rail expanding into it.
      await page.goto(`${env("CODEDEN_E2E_URL")}/inbox`);
      if (size.nav === "drawer") {
        await page.getByTestId("mobile-nav-button").click();
      } else {
        await expect(page.getByTestId("mobile-nav-button")).toHaveCount(0);
        await page.getByRole("button", { name: "Expand sidebar" }).click();
      }
      const drawer = page.getByTestId("mobile-nav");
      await expect(drawer).toBeVisible();
      await drawer.getByRole("link", { name: /Orchestrator/ }).click();
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(/\/$/);

      // The right panel opens over the transcript as a sheet, then closes.
      await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${sessionId}`);
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      const sheet = page.getByTestId("right-sheet");
      await expect(sheet).toBeVisible();
      const box = await sheet.boundingBox();
      // Full width on phones (to within a pixel: Linux Chromium reports 390.00001...).
      if (size.name === "phone") expect(box?.width ?? 0).toBeCloseTo(size.viewport.width, 0);
      await sheet.getByRole("button", { name: "Close panel" }).click();
      await expect(sheet).toBeHidden();

      // Tap targets in the header and composer are at least 40 px tall.
      for (const name of ["Toggle right panel", "Attach files"]) {
        const height = (await page.getByRole("button", { name }).boundingBox())?.height ?? 0;
        expect(height, name).toBeGreaterThanOrEqual(39.5); // 40 px, allowing sub-pixel layout
      }
      // Row actions are visible without hover on touch screens.
      if (size.nav === "drawer") {
        await page.getByTestId("mobile-nav-button").click();
        const home = page.getByTestId("mobile-nav").locator('a[title="Project home"]').first();
        await expect(home).toBeVisible();
        const opacity = await home.evaluate(
          (el) => getComputedStyle(el.parentElement as Element).opacity,
        );
        expect(opacity).toBe("1");
      }
    } finally {
      await context.close();
    }
  });
}

type Box = { x: number; y: number; width: number; height: number };

/** The area two boxes share, in px² (0 when they are apart). */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

for (const size of SIZES) {
  test(`toasts leave the composer clear on a ${size.name}`, async ({ browser }) => {
    const { context, page } = await openContext(browser, size);
    try {
      await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${sessionId}`);
      const message = page.getByRole("textbox", { name: "Message" });
      // A message being written grows the box; toasts must clear its actual height.
      await message.fill("First line\nSecond line\nThird line\nFourth line");
      // Toggling Plan raises a toast ("Plan mode on/off") while the composer is in use.
      await page.getByRole("button", { name: "Plan mode" }).tap();
      const toast = page.locator("[data-sonner-toast]").first();
      await expect(toast).toBeVisible();
      await page.waitForTimeout(600); // the toast's enter animation
      // The message box and its toolbar (model, permissions, Plan, Queue/Steer, Stop, Send).
      const composer = await message.locator("xpath=..").boundingBox();
      const toastBox = await toast.boundingBox();
      expect(composer, "composer box").not.toBeNull();
      expect(toastBox, "toast box").not.toBeNull();
      expect(
        overlapArea(composer as Box, toastBox as Box),
        `toast ${JSON.stringify(toastBox)} covers the composer ${JSON.stringify(composer)}`,
      ).toBe(0);
    } finally {
      await context.close();
    }
  });
}

test("the app can be added to a home screen", async ({ page }) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  // Fetched without the cookie, as browsers do for manifests and icons.
  const manifest = await fetch(`${env("CODEDEN_E2E_URL")}/manifest.webmanifest`);
  expect(manifest.ok).toBe(true);
  const body = (await manifest.json()) as {
    display: string;
    icons: { src: string; purpose: string }[];
  };
  expect(body.display).toBe("standalone");
  expect(body.icons.filter((i) => i.purpose === "maskable")).toHaveLength(2);
  for (const icon of body.icons) {
    const res = await fetch(`${env("CODEDEN_E2E_URL")}${icon.src}`);
    expect(res.headers.get("content-type")).toBe("image/png");
  }
});
