import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  const setup = `node -e "require('fs').writeFileSync('setup-ran.txt', 'yes'); console.log('setup output')"`;
  h = await startHarness({}, { ".codeden/project.json": JSON.stringify({ setup: [setup] }) });
});

afterAll(async () => {
  await h?.close();
});

it("runs .codeden/project.json setup commands in a new worktree and records their output", async () => {
  const id = await h.startFakeSession();
  const detail = await h.detail(id);
  const worktree = detail.session.worktreePath;
  expect(worktree).toBeTruthy();
  expect(existsSync(join(worktree as string, "setup-ran.txt"))).toBe(true);
  expect(detail.startMeta?.setup).toEqual([
    expect.objectContaining({
      status: "succeeded",
      output: expect.stringContaining("setup output"),
    }),
  ]);
});
