import { expect, type Page, test } from "@playwright/test";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`global setup did not set ${name}`);
  return value;
};

/** JSON call to the server under test with the install token; returns status and body. */
async function call<T>(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${env("CODEDEN_E2E_URL")}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env("CODEDEN_E2E_TOKEN")}` },
    data: body,
  });
  return { status: res.status(), json: (await res.json().catch(() => null)) as T };
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call<T>(page, method, path, body);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
  return res.json;
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

test.beforeEach(async ({ page }) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await api(page, "POST", "/setup/complete", {});
  // Role sessions run on the Fake provider in tests.
  await api(page, "PATCH", "/settings", {
    providers: { orchestrator: { provider: "fake" }, pm: { provider: "fake" } },
  });
});

test("orchestrator and PM chats reply, with the status digest folded away", async ({ page }) => {
  const project = await projectId(page);

  await test.step("the first message starts the orchestrator and gets a reply", async () => {
    await page.goto(`${env("CODEDEN_E2E_URL")}/`);
    await expect(page.getByText("What should we build?")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("What's going on across my projects?");
    await composer.press("Enter");
    await expect(page.getByText(/^Echo: /).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("read-only-badge")).toBeVisible();
  });

  await test.step("the digest is a collapsed disclosure, not raw text", async () => {
    const disclosure = page.getByTestId("digest-disclosure").first();
    const toggle = disclosure.getByRole("button", { name: /Status sent to agent/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The first message also names the conversation (sidebar, header) once titled.
    await expect(
      page.getByText("What's going on across my projects?", { exact: true }).first(),
    ).toBeVisible();
    await expect(disclosure.locator("pre")).toHaveCount(0);
    await toggle.click();
    await expect(disclosure.locator("pre")).toContainText("codeden_status");
  });

  await test.step("follow-ups from the session composer keep their text", async () => {
    // The Fake provider reacts to "[approval]" anywhere in its input, and the digest can name
    // earlier "[approval]" work: approve until the first turn is done.
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(async () => {
      if (await approve.isVisible()) await approve.click();
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("And what is waiting on me?");
    await composer.press("Enter");
    await expect(
      page.getByText("And what is waiting on me?", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("digest-disclosure")).toHaveCount(2);
    await expect(page.getByText(/^Echo: /)).toHaveCount(2, { timeout: 30_000 });
  });

  await test.step("the PM chat works the same way", async () => {
    await page.goto(`${env("CODEDEN_E2E_URL")}/projects/${project}/pm`);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("What's running?");
    await composer.press("Enter");
    await expect(page.getByText(/^Echo: /).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("What's running?", { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-role="pm"]').first()).toBeVisible();
  });
});

test("conflict cards resolve inline and from the inbox", async ({ page }) => {
  const project = await projectId(page);
  const workKey = `e2e:conflict-${Date.now()}`;
  const running = await api<{ status: string; sessionId: string }>(page, "POST", "/sessions", {
    projectId: project,
    provider: "fake",
    workKey,
    purpose: "Hold the work key",
    input: { text: "Hold the work key [approval]" },
  });
  expect(running.status).toBe("started");

  await test.step("starting duplicate work shows the conflict card inline", async () => {
    // The old dialog link still opens the New session draft.
    await page.goto(`${env("CODEDEN_E2E_URL")}/projects/${project}?newSession=true`);
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/new$`));
    const draft = page.getByTestId("new-session");
    await draft.getByRole("button", { name: "Session options" }).click();
    await page.getByLabel(/Work key/).fill(workKey);
    await page.keyboard.press("Escape");
    await expect(draft.getByTestId("work-key-chip")).toHaveText(workKey);
    await draft.getByRole("textbox", { name: "Message" }).fill("Do the same thing again");
    await draft.getByRole("button", { name: "Send" }).click();
    const card = draft.getByTestId("conflict-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Hold the work key");
    await card.getByRole("button", { name: /Skip/ }).click();
    await expect(page.getByText("Skipped")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
  });

  await test.step("a persisted conflict is listed in the inbox and forced with a reason", async () => {
    const res = await call<{ status: string; conflictId?: string }>(page, "POST", "/sessions", {
      projectId: project,
      provider: "fake",
      workKey,
      input: { text: "Duplicate from the API" },
    });
    expect(res.status).toBe(409);
    expect(res.json.conflictId).toBeTruthy();
    await page.goto(`${env("CODEDEN_E2E_URL")}/inbox`);
    const card = page.getByTestId("conflict-card").filter({ hasText: workKey });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /Force/ }).click();
    await card.getByLabel("Reason to start anyway").fill("Needed a second run");
    await card.getByRole("button", { name: "Start anyway" }).click();
    await expect(page).toHaveURL(/\/sessions\//);
    const open = await api<{ id: string }[]>(page, "GET", `/conflicts?projectId=${project}`);
    expect(open.find((c) => c.id === res.json.conflictId)).toBeUndefined();
  });

  await api(page, "POST", `/sessions/${running.sessionId}/stop`, {});
});
