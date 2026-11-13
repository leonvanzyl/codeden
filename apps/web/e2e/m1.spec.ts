import { expect, type Page, test } from "@playwright/test";

const launchUrl = () => {
  const url = process.env.CODEDEN_E2E_LAUNCH_URL;
  if (!url) throw new Error("global setup did not start a server");
  return url;
};

/** Visible text of the xterm screen. */
const terminalText = (page: Page) =>
  page
    .locator(".xterm-rows")
    .textContent()
    .then((t) => t ?? "");

test("without the launch token the server stays locked", async ({ page }) => {
  const origin = new URL(launchUrl()).origin;
  await page.goto(origin);
  await expect(page.getByText("CodeDen is locked")).toBeVisible();
  const res = await page.request.get(`${origin}/api/snapshot`);
  expect(res.status()).toBe(401);
});

test("an expired cookie shows the open-from-terminal screen", async ({ page, context }) => {
  await page.goto(launchUrl());
  await expect(page).toHaveURL(/\/setup$/);
  await context.clearCookies();
  // Any API call now answers 401, and the app swaps to the friendly screen.
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByTestId("unauthorized")).toBeVisible();
  await expect(page.getByText("Open CodeDen from the terminal link")).toBeVisible();
});

test("M1 flow with the Fake provider", async ({ page }) => {
  await test.step("setup screen renders the detection checks", async () => {
    await page.goto(launchUrl());
    await expect(page).toHaveURL(/\/setup$/);
    const checklist = page.getByTestId("setup-checklist");
    await expect(checklist.locator("[data-check=git]")).toBeVisible();
    await expect(checklist.getByText("Checking…")).toHaveCount(0, { timeout: 60_000 });
    for (const id of ["claude", "codex", "opencode", "gh", "git", "browser"]) {
      await expect(checklist.locator(`[data-check=${id}]`)).toBeVisible();
    }
    await page.getByRole("button", { name: "Skip setup" }).click();
    await expect(page.getByText("What should we build?")).toBeVisible();
  });

  await test.step("create a project from a temp git repo", async () => {
    await page.getByRole("button", { name: "Add project" }).first().click();
    const dialog = page.getByRole("dialog");
    const path = dialog.getByLabel("Folder path");
    await path.fill(process.env.CODEDEN_E2E_REPO ?? "");
    await path.press("Enter");
    await dialog.getByRole("button", { name: "Add project" }).click();
    // A new project opens its New session view, ready for the first task.
    await expect(page).toHaveURL(/\/projects\/[^/]+\/new$/);
    await expect(page.getByTestId("new-session")).toBeVisible();
    await page.goto(page.url().replace(/\/new$/, ""));
    await expect(page.getByRole("heading", { name: "demo-repo" })).toBeVisible();
  });

  await test.step("a new project gets the starter automations, all off", async () => {
    const list = page.getByTestId("automations-list");
    for (const name of ["Security audit", "Dependency updates", "Test coverage gaps"]) {
      await expect(list.getByRole("switch", { name: `Enable ${name}` })).not.toBeChecked();
    }
    // GitHub-only templates (triage, stale PRs) are not offered to a local folder.
    await expect(list.getByText("Issue triage")).toHaveCount(0);
    await expect(page.getByTestId("next-runs")).toContainText("No scheduled runs");
  });

  await test.step("start a Fake session from the draft and stream the transcript", async () => {
    // The project page's button (the sidebar's "+" is a link of the same name).
    await page.getByRole("main").getByRole("link", { name: "New session" }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/new$/);
    const draft = page.getByTestId("new-session");
    await expect(draft.getByRole("button", { name: "Provider and model" })).toContainText(/Fake/);
    await draft.getByLabel("Message", { exact: true }).fill("Say hello [approval]");
    await draft.getByLabel("Message", { exact: true }).press("Enter");
    await expect(page).toHaveURL(/\/sessions\//);
    await expect(page.getByText("Echo: Say hello [approval]")).toBeVisible();
  });

  await test.step("approve the approval card inline", async () => {
    await expect(page.getByText("Approval needed").first()).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Approved once")).toBeVisible();
  });

  await test.step("follow-up chips appear when the turn completes", async () => {
    await expect(page.getByRole("button", { name: "Add tests" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open a PR" })).toBeVisible();
  });

  await test.step("the terminal echoes input", async () => {
    await page.getByRole("tab", { name: "Terminal" }).click();
    const terminal = page.getByTestId("terminal");
    await expect(terminal.locator(".xterm-rows")).toBeVisible();
    // Wait for the shell prompt before typing.
    await expect
      .poll(async () => (await terminalText(page)).trim().length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await terminal.click();
    await page.keyboard.type(
      `node -e "require('fs').writeFileSync('e2e-note.txt', 'hello from e2e\\n'); console.log('e2e-' + 'terminal-ok')"`,
    );
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("e2e-terminal-ok");
  });

  await test.step("the diff panel shows the change", async () => {
    await page.getByRole("tab", { name: "Diff" }).click();
    const diff = page.getByTestId("diff-panel");
    await expect(async () => {
      await diff.getByRole("button", { name: "Refresh diff" }).click();
      await expect(diff.locator('[data-file="e2e-note.txt"]')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(diff.getByText(/1 uncommitted/)).toBeVisible();
  });
});
