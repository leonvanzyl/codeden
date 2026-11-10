import { expect, type Page, test } from "@playwright/test";

/**
 * OpenCode end to end: the runner loads OpenCode against the scripted stand-in (the e2e
 * server passes `--opencode`), so its models show in the picker and a session runs through
 * server -> runner -> `opencode serve` without a real model.
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
  const json = (await res.json().catch(() => null)) as T;
  expect(res.status(), `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
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

test.beforeEach(async ({ page }) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await api(page, "POST", "/setup/complete", {});
});

test("an OpenCode session runs through the runner and its models show in the picker", async ({
  page,
}) => {
  const project = await projectId(page);
  const started = await api<{ status: string; sessionId: string }>(page, "POST", "/sessions", {
    projectId: project,
    provider: "opencode",
    model: "anthropic/claude-opus-5-5",
    effort: "high",
    autonomy: "auto",
    purpose: "Say hello through OpenCode",
    workspace: { mode: "repo_root" },
    input: { text: "hello" },
  });

  await test.step("the session shows OpenCode's reply", async () => {
    await page.goto(`${env("CODEDEN_E2E_URL")}/sessions/${started.sessionId}`);
    await expect(page.getByText("Hello from fake OpenCode.").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("the picker lists OpenCode's models by provider", async () => {
    await page
      .getByRole("button", { name: /^Provider and model/ })
      .first()
      .click();
    const picker = page.getByTestId("model-picker");
    await picker.getByRole("button", { name: /^OpenCode/ }).click();
    await expect(picker.getByRole("option", { name: /^Claude Opus 5\.5/ })).toBeVisible();
    await expect(picker.getByRole("option", { name: /^GPT-5\.5/ })).toBeVisible();
    await expect(picker.getByRole("option", { name: /^GPT OSS 20B/ })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
