import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Phone and tablet smoke (§13): the main screens fit without horizontal scroll at 390x844,
 * 820x1180 and 1180x820 on a touch screen, the sidebar is a drawer (or a rail in landscape)
 * and the right panel opens as a sheet. Toasts keep clear of the composer at every size,
 * including a desktop window where the right panel and terminal drawer move it. On a phone
 * the Agents page's config files open at full width.
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
        ["agents", "/agents?tab=memory&project=global"],
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

test("the Agents page's files get the whole screen on a phone", async ({ browser }) => {
  const phone = SIZES[0];
  // A user skill, so the Skills tab has a row with an on/off switch.
  const skill = join(env("CODEDEN_E2E_USER_HOME"), ".claude", "skills", "phone-check");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: phone-check\ndescription: Used by the phone layout test\n---\n\nSay hi.\n",
  );
  const { context, page } = await openContext(browser, phone);
  try {
    const agents = (tab: string) =>
      page.goto(`${env("CODEDEN_E2E_URL")}/agents?tab=${tab}&project=global`);
    // Memory, Skills and Subagents share one list + editor view. On a phone the list comes
    // first, and picking a file opens it in the list's place.
    await agents("memory");
    const row = page.locator('[data-config-path=".claude/CLAUDE.md"]');
    const editor = page.getByTestId("config-file-editor");
    await row.tap();
    await expect(editor.locator(".cm-content")).toContainText("Keep answers short.");
    await expect(row).toBeHidden();
    const box = (await editor.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    // Most of the 390 px screen, not the sliver left beside a fixed-width file list.
    expect(box.width, `editor is ${box.width} px wide`).toBeGreaterThanOrEqual(
      phone.viewport.width * 0.8,
    );
    // The toolbar's controls sit inside the editor, not clipped off its right edge, and are
    // 40 px tap targets (allowing sub-pixel layout).
    const editorRight = box.x + box.width;
    for (const name of ["Back to files", "Revert", /^Delete /, "Review & save"]) {
      const button = (await editor.getByRole("button", { name }).boundingBox()) ?? box;
      const right = button.x + button.width;
      expect(right, `${name} ends at ${right}, the editor at ${editorRight}`).toBeLessThanOrEqual(
        editorRight + 0.5,
      );
      expect(Math.min(button.width, button.height), `${name}`).toBeGreaterThanOrEqual(39.5);
    }
    // The whole path shows, not cut off.
    const path = editor.locator("code").first();
    await expect(path).toHaveText(/CLAUDE\.md$/);
    expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Back, from the keyboard, returns to the list.
    await editor.getByRole("button", { name: "Back to files" }).focus();
    await page.keyboard.press("Enter");
    await expect(row).toBeVisible();
    await expect(editor).toBeHidden();

    // Skills: a row's switch takes a tap just above its 14 px track (a 40 px target).
    await agents("skills");
    const toggle = page.getByRole("switch", { name: "phone-check: on" });
    await toggle.tap({ position: { x: 12, y: -10 } });
    await page.getByRole("button", { name: "Keep editing" }).tap();
    await expect(toggle).toBeVisible();

    // MCP servers and Hooks are single lists: they fit without scrolling sideways.
    for (const tab of ["mcp", "hooks"]) {
      await agents(tab);
      await page.locator("main").waitFor();
      await page.waitForTimeout(300);
      await expectNoHorizontalScroll(page, `agents ${tab}`);
    }
  } finally {
    await context.close();
    rmSync(skill, { recursive: true, force: true });
  }
});

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

test("toasts follow the composer as the panel and terminal move it on a desktop", async ({
  browser,
}) => {
  const viewport = { width: 1600, height: 900 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
    await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${sessionId}`);
    const composer = page.getByRole("textbox", { name: "Message" }).locator("xpath=..");
    await composer.waitFor();
    const toast = page.locator('[data-sonner-toast][data-removed="false"]');
    /** Raise a toast and wait for it to settle in the corner or just above the composer. */
    const expectToast = async (where: "in the corner" | "above the composer") => {
      await page.getByRole("button", { name: "Plan mode" }).click();
      await expect(toast).toHaveCount(1);
      await expect
        .poll(async () => {
          const c = await composer.boundingBox();
          const t = await toast.boundingBox();
          if (!c || !t) return "missing";
          const bottom = t.y + t.height;
          const gap = c.y - bottom;
          if (overlapArea(c, t) === 0 && Math.abs(bottom - (viewport.height - 24)) <= 1) {
            return "in the corner";
          }
          if (overlapArea(c, t) === 0 && gap >= 0 && gap <= 12) return "above the composer";
          return `toast ${JSON.stringify(t)}, composer ${JSON.stringify(c)}`;
        })
        .toBe(where);
    };
    const panel = page.getByRole("button", { name: "Toggle right panel" });
    const terminal = page.getByRole("button", { name: "Toggle terminal" });
    const at = async () => (await composer.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const start = await at();

    // The right panel is open, so the composer sits beside the toasts' corner column.
    await expectToast("in the corner");
    // Each change below moves the composer without resizing it; toasts follow where it is now.
    await panel.click(); // closed: the composer re-centres under the corner column
    await expect.poll(async () => (await at()).x).toBeGreaterThan(start.x + 100);
    await expectToast("above the composer");
    await terminal.click(); // open: the composer moves up
    await expect.poll(async () => (await at()).y).toBeLessThan(start.y - 100);
    await expectToast("above the composer");
    await terminal.click(); // closed: the composer moves back down
    await expect.poll(async () => (await at()).y).toBe(start.y);
    await expectToast("above the composer");
    await panel.click(); // open again: the composer is beside the column, toasts go back
    await expect.poll(async () => (await at()).x).toBe(start.x);
    await expectToast("in the corner");
    expect((await at()).width, "the composer kept its size").toBe(start.width);
  } finally {
    await context.close();
  }
});

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
