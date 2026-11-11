import { FactoryLoop, FactoryTuning } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import type { FactoryPr } from "../src/services/factory/github-port";
import {
  changeSize,
  isUncountedFile,
  overSizeLimit,
  sizeLimitText,
} from "../src/services/factory/size";
import { upgradeSizeLimits } from "../src/services/factory/store";

const pr = (fileLines: Array<{ path: string; lines: number }> | undefined): FactoryPr => ({
  ref: { number: 3, url: "https://github.com/acme/app/pull/3", state: "open" },
  title: "Scaffold",
  body: "",
  headSha: "abc",
  headBranch: "codeden/scaffold",
  checks: "success",
  failedChecks: [],
  mergeable: "mergeable",
  additions: 10_000,
  deletions: 797,
  files: (fileLines ?? []).map((f) => f.path),
  ...(fileLines ? { fileLines } : {}),
});

describe("size check counting (§10.1)", () => {
  it("leaves lockfiles and generated or vendored files out", () => {
    for (const path of [
      "package-lock.json",
      "apps/web/pnpm-lock.yaml",
      "yarn.lock",
      "Cargo.lock",
      "go.sum",
      "dist/index.js",
      "web/build/app.js",
      "vendor/lib/x.go",
      "src/__snapshots__/app.test.ts.snap",
      "public/app.min.js",
      "src/app.js.map",
      "src/routeTree.gen.ts",
      "src/components/ui/button.tsx",
      "apps/web/src/components/ui/dialog.tsx",
    ]) {
      expect(isUncountedFile(path), path).toBe(true);
    }
    for (const path of [
      "src/app.tsx",
      "src/components/board.tsx",
      "src/ui/theme.ts",
      "src/build-info.ts",
      "package.json",
      "README.md",
    ]) {
      expect(isUncountedFile(path), path).toBe(false);
    }
  });

  it("counts only the code someone reviews", () => {
    const size = changeSize(
      pr([
        { path: "src/app.tsx", lines: 1_200 },
        { path: "src/components/ui/button.tsx", lines: 300 },
        { path: "package-lock.json", lines: 9_000 },
      ]),
    );
    expect(size).toEqual({ lines: 1_200, files: 1, uncounted: 2 });
  });

  it("falls back to the PR totals without per-file numbers", () => {
    expect(changeSize(pr(undefined))).toEqual({ lines: 10_797, files: 0, uncounted: 0 });
  });

  it("treats a null limit as no limit", () => {
    const size = { lines: 250_000, files: 900, uncounted: 0 };
    const off = { maxChangedLines: null, maxChangedFiles: null };
    expect(overSizeLimit(size, off)).toBe(false);
    expect(sizeLimitText(off)).toBe("no limit");
    const defaults = FactoryTuning.parse({});
    expect(overSizeLimit(size, defaults)).toBe(true);
    expect(sizeLimitText(defaults)).toBe("5,000 lines");
    expect(overSizeLimit({ ...size, lines: 10 }, { ...off, maxChangedFiles: 40 })).toBe(true);
  });
});

describe("upgradeSizeLimits", () => {
  const loop = (maxChangedLines: number | null, maxChangedFiles: number | null) =>
    FactoryLoop.parse({
      projectId: "p1",
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-09",
      mergesToday: 0,
      discovery: [],
      nextArea: 0,
      lastDiscoveryAt: null,
      lastDigestDay: null,
      enabledAt: null,
      tuning: { maxChangedLines, maxChangedFiles, maxFixAttempts: 2 },
      lastTickAt: null,
      updatedAt: "2026-11-09T10:00:00.000Z",
    });

  it("moves untouched old defaults to the current defaults", () => {
    const up = upgradeSizeLimits(loop(800, 40));
    expect(up.tuning.maxChangedLines).toBe(5_000);
    expect(up.tuning.maxChangedFiles).toBeNull();
    expect(up.tuning.maxFixAttempts).toBe(2);
  });

  it("keeps limits someone chose", () => {
    expect(upgradeSizeLimits(loop(800, 100)).tuning).toMatchObject({
      maxChangedLines: 800,
      maxChangedFiles: 100,
    });
    expect(upgradeSizeLimits(loop(null, null)).tuning.maxChangedLines).toBeNull();
  });
});
