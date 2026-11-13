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

const composer = (page: Page) => page.getByLabel("Message", { exact: true });
const tray = (page: Page) => page.getByRole("region", { name: "Queued messages" });
const approve = (page: Page) => page.getByRole("button", { name: "Approve", exact: true });

async function type(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Wait until no turn runs, approving anything the Fake provider asks along the way. */
async function settle(page: Page) {
  await expect(async () => {
    if (await approve(page).isVisible()) await approve(page).click();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
}

/** A role chat: a held turn, then a message that waits in the tray, then cleanup. */
async function trayInRoleChat(page: Page, url: string, label: string) {
  await page.goto(url);
  await settle(page);
  await type(page, `${label}: hold on [approval]`);
  await expect(approve(page).first()).toBeVisible({ timeout: 30_000 });
  await type(page, `${label}: and after that`);
  await expect(tray(page)).toContainText(`${label}: and after that`);
  await expect(tray(page).getByText("Next")).toBeVisible();
  await settle(page);
  await expect(tray(page)).toHaveCount(0, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await api(page, "POST", "/setup/complete", {});
  await api(page, "PATCH", "/settings", {
    providers: { orchestrator: { provider: "fake" }, pm: { provider: "fake" } },
  });
});

test("messages sent during a turn wait in the tray, can be edited or deleted, then deliver", async ({
  page,
}) => {
  const project = await projectId(page);
  const started = await api<{ status: string; sessionId: string }>(page, "POST", "/sessions", {
    projectId: project,
    provider: "fake",
    purpose: "Queue behind an approval",
    input: { text: "Change a file [approval]" },
  });
  expect(started.status).toBe("started");
  await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${started.sessionId}`);
  await expect(page.getByText("Approval needed").first()).toBeVisible({ timeout: 30_000 });

  await test.step("send three messages while the turn waits", async () => {
    for (const text of ["Then run the tests", "Then update the docs", "Then open a PR"]) {
      await type(page, text);
    }
    const rows = tray(page).getByTestId("queued-message");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Next");
    await expect(rows.nth(0)).toContainText("Then run the tests");
    await expect(rows.nth(1)).toContainText("2nd");
    await expect(rows.nth(2)).toContainText("3rd");
    // The Fake provider can steer, so each message offers send-now.
    await expect(rows.nth(0).getByRole("button", { name: "Send now" })).toBeVisible();
  });

  await test.step("edit the first and delete the second", async () => {
    const rows = tray(page).getByTestId("queued-message");
    await rows.nth(0).getByRole("button", { name: "Edit" }).click();
    const box = tray(page).getByRole("textbox", { name: "Edit queued message" });
    await box.fill("Then run the whole test suite");
    await tray(page).getByRole("button", { name: "Save" }).click();
    await expect(rows.nth(0)).toContainText("Then run the whole test suite");
    await rows.nth(1).getByRole("button", { name: "Delete" }).click();
    await expect(rows).toHaveCount(2);
    await expect(tray(page)).not.toContainText("Then update the docs");
  });

  await test.step("approve: the queue delivers one message per turn into the transcript", async () => {
    await approve(page).click();
    await expect(tray(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("Echo: Then run the whole test suite")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Echo: Then open a PR")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Echo: Then update the docs")).toHaveCount(0);
  });
});

test("the orchestrator and PM chats show the tray too", async ({ page }) => {
  const project = await projectId(page);
  await trayInRoleChat(page, `${env("CODEDEN_E2E_URL")}/projects/${project}/pm`, "PM");
  await trayInRoleChat(page, `${env("CODEDEN_E2E_URL")}/`, "Orchestrator");
});
