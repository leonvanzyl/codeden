import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A committed repo whose origin is on GitHub (never contacted for this test's assertions). */
function githubRepo(): string {
  const repo = join(mkdtempSync(join(tmpdir(), "codeden-e2e-factory-")), "factory-demo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  git("config", "user.email", "e2e@codeden.test");
  git("config", "user.name", "CodeDen E2E");
  writeFileSync(join(repo, "README.md"), "# Factory demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://github.com/codeden-e2e/factory-demo.git");
  return repo;
}

test("switch a GitHub project to the software factory with a vision and limits; the pipelines show", async ({
  page,
}) => {
  await page.goto(env("CODEDEN_E2E_LAUNCH_URL"));
  await api(page, "POST", "/setup/complete", {});
  const { project } = await api<{ project: { id: string; kind: string } }>(
    page,
    "POST",
    "/projects",
    { source: { type: "local", path: githubRepo() } },
  );
  expect(project.kind).toBe("github");
  const base = env("CODEDEN_E2E_URL");
  await page.goto(`${base}/projects/${project.id}`);

  await test.step("the software factory is experimental and lists what is missing", async () => {
    await page.getByTestId("autonomy-mode-button").click();
    const dialog = page.getByRole("dialog");
    const factory = dialog.getByRole("button", { name: /^Software factory/ });
    await expect(factory).toContainText("experimental");
    await factory.click();
    const reqs = dialog.getByTestId("mode-requirements");
    await expect(reqs.locator("li[data-ok=true]")).toContainText("A GitHub project");
    await expect(reqs.locator("li[data-ok=false]")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Switch to Software factory" })).toBeDisabled();
    await dialog.getByRole("link", { name: "Write the vision →" }).click();
  });

  await test.step("the vision editor starts from the template and previews protected areas", async () => {
    await expect(page).toHaveURL(/\/vision$/);
    await expect(page.getByText("No vision file yet")).toBeVisible();
    await expect(page.getByTestId("protected-globs")).toContainText("**/auth/**");
    await expect(page.getByTestId("protected-topics")).toContainText("payments");
    await page.getByRole("button", { name: "Create vision file" }).click();
    await page.getByRole("button", { name: "Save to file" }).click();
    await expect(page.getByText("Vision saved")).toBeVisible();
    await expect(page.getByText("No vision file yet")).toHaveCount(0);
  });

  await test.step("with a daily budget the switch goes through", async () => {
    await page.goto(`${base}/projects/${project.id}`);
    await page.getByTestId("autonomy-mode-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Software factory/ }).click();
    await dialog.getByLabel("Daily budget (USD)").fill("5");
    await dialog.getByLabel("Agents at once").fill("2");
    await expect(dialog.getByTestId("mode-requirements").locator("li[data-ok=false]")).toHaveCount(
      0,
    );
    await dialog.getByRole("button", { name: "Switch to Software factory" }).click();
    await expect(page.getByText("is now a software factory")).toBeVisible();
  });

  await test.step("the factory panel shows the pipelines, the loop, its limits and controls", async () => {
    const panel = page.getByTestId("factory-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("factory-loop-state")).toHaveText(
      /^Loop (idle|building|verifying|paused|discovering)$/,
    );
    await expect(panel.getByTestId("pipeline-diagram")).toBeVisible();
    await expect(panel.getByTestId("pipeline-diagram")).toContainText("Reproduce");
    await expect(panel).toContainText("$0.00 / $5.00");
    await expect(panel).toContainText("0 / 2");
    await expect(page.getByTestId("autonomy-mode-button")).toContainText("Software factory");
    await expect(panel.getByRole("button", { name: "Kill switch" })).toBeVisible();
  });

  await test.step("the project kill switch asks first, then stops the loop", async () => {
    const panel = page.getByTestId("factory-panel");
    await panel.getByRole("button", { name: "Kill switch" }).click();
    // Two ways to stop: finishing current work first (offered first), or Stop now.
    await expect(page.getByRole("menuitem").first()).toContainText(
      "Finish current work, then stop",
    );
    await page.getByRole("menuitem", { name: /Stop now/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop everything" }).click();
    await expect(panel.getByTestId("factory-loop-state")).toHaveText("Loop stopped");
    await panel.getByRole("button", { name: "Release kill switch" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Release" }).click();
    await expect(panel.getByRole("button", { name: "Kill switch" })).toBeVisible();
  });

  await api(page, "PUT", `/projects/${project.id}/autonomy`, { mode: "assisted" });
});
