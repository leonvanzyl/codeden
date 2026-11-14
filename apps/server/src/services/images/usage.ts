import { ImageUsage } from "@codeden/contracts";
import { writeJsonFile } from "../../json-file";
import { type FileReset, loadUserJsonFile } from "../../user-json-file";
import { ServiceError } from "../errors";

/** Local calendar date, `YYYY-MM-DD`. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Images generated per local day (`<home>/image-usage.json`), for the daily caps (§12.5).
 * Counts are reserved before an engine runs and released if it fails, so parallel calls
 * cannot overshoot a cap.
 */
export class ImageUsageStore {
  private usage: ImageUsage;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
    /** Called when a damaged file was kept as a copy and the counts started again from 0. */
    onReset?: (reset: FileReset) => void,
  ) {
    const { value, reset } = loadUserJsonFile(file, ImageUsage, {
      defaults: () => ({ date: localDate(this.now()), total: 0, byProject: {} }),
    });
    this.usage = value;
    if (reset) onReset?.(reset);
  }

  /** Today's usage (resets when the date changed). */
  today(): ImageUsage {
    const date = localDate(this.now());
    if (this.usage.date !== date) this.usage = { date, total: 0, byProject: {} };
    return structuredClone(this.usage);
  }

  /** Reserve `count` images or throw `daily_cap_reached`. */
  reserve(count: number, caps: { global: number; project?: number }, projectId: string | null) {
    const usage = this.today();
    if (usage.total + count > caps.global) {
      throw new ServiceError(
        409,
        "daily_cap_reached",
        `The daily image cap (${caps.global}) is reached: ${usage.total} generated today. Raise it in Settings > Image generation.`,
      );
    }
    const used = projectId ? (usage.byProject[projectId] ?? 0) : 0;
    if (projectId && caps.project !== undefined && used + count > caps.project) {
      throw new ServiceError(
        409,
        "daily_cap_reached",
        `This project's daily image cap (${caps.project}) is reached: ${used} generated today.`,
      );
    }
    this.add(count, projectId);
  }

  /** Give back images that were reserved but not produced. */
  release(count: number, projectId: string | null): void {
    if (count > 0) this.add(-count, projectId);
  }

  private add(count: number, projectId: string | null): void {
    const usage = this.today();
    usage.total = Math.max(0, usage.total + count);
    if (projectId)
      usage.byProject[projectId] = Math.max(0, (usage.byProject[projectId] ?? 0) + count);
    this.usage = usage;
    writeJsonFile(this.file, usage);
  }
}
