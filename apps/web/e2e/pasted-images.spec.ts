import { expect, type Page, test } from "@playwright/test";

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
  const json = (await res.json().catch(() => null)) as T;
  expect(res.status(), `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

/** The demo repo's project (created by an earlier spec, or here). */
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

/** A 1x1 PNG: a thumbnail that loaded has a natural width above zero, a broken one has 0. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Paste an image file into the composer the way the clipboard does. */
async function pasteImage(page: Page) {
  const composer = page.getByLabel("Message", { exact: true });
  await composer.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PNG_B64);
  await expect(page.getByRole("button", { name: "Remove image.png" })).toBeAttached();
}

/** Wait until no turn runs, approving anything the Fake provider asks along the way. */
async function settle(page: Page) {
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(async () => {
    if (await approve.isVisible()) await approve.click();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
}

/** The pasted image in the transcript: a thumbnail loaded from its artifact. */
const transcriptThumbnail = (page: Page) => page.locator('img[src*="/api/artifacts/"]').first();

const loaded = (img: ReturnType<Page["locator"]>) =>
  expect
    .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
    .toBeGreaterThan(0);

async function expectLoaded(page: Page) {
  const img = transcriptThumbnail(page);
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect(img).toHaveAttribute("alt", "image.png");
  await loaded(img);
}

/** Clicking the thumbnail opens the full image in the in-app viewer; Escape closes it. */
async function expectOpensInViewer(page: Page) {
  await page.getByRole("button", { name: "View image.png" }).first().click();
  const viewer = page.getByRole("dialog");
  await expect(viewer.getByRole("heading", { name: "image.png" })).toBeVisible();
  const full = viewer.getByRole("img", { name: "image.png" });
  await expect(full).toHaveAttribute("src", /\/api\/artifacts\//);
  await loaded(full);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
}

/** Paste, send, see the thumbnail load, reload, see it load again. */
async function pasteSendAndReload(page: Page, text: string) {
  await settle(page);
  await pasteImage(page);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expectLoaded(page);
  await page.reload();
  await expectLoaded(page);
  await expectOpensInViewer(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await api(page, "POST", "/setup/complete", {});
  await api(page, "PATCH", "/settings", {
    providers: { orchestrator: { provider: "fake" }, pm: { provider: "fake" } },
  });
});

test("a pasted image shows as a thumbnail in a project session, also after a reload", async ({
  page,
}) => {
  const project = await projectId(page);
  const started = await api<{ status: string; sessionId: string }>(page, "POST", "/sessions", {
    projectId: project,
    provider: "fake",
    purpose: "Look at pasted images",
    input: { text: "Get ready for an image" },
  });
  expect(started.status).toBe("started");
  await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${started.sessionId}`);
  await expect(page.getByText("Echo: Get ready for an image")).toBeVisible({ timeout: 30_000 });
  await pasteSendAndReload(page, "What is in this screenshot?");
});

test("a pasted image shows as a thumbnail in the orchestrator chat, also after a reload", async ({
  page,
}) => {
  await page.goto(`${env("CODEDEN_E2E_URL")}/`);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Hello orchestrator");
  await composer.press("Enter");
  await expect(page.getByText(/^Echo: /).first()).toBeVisible({ timeout: 30_000 });
  // The exact-text match on the bubble also shows the injected digest stayed folded away
  // (the Fake provider's reply echoes the whole prompt, digest included, so look only there).
  await pasteSendAndReload(page, "Here are two screenshots of the bug");
});
