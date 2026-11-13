import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Artifact,
  ImageEngineSetting,
  ImageEnginesResponse,
  ImageTestRequest,
  ImageTestResponse,
  Role,
} from "@codeden/contracts";
import {
  type ImageAspectRatio,
  type ImageEngineRegistry,
  ImageGenerationError,
  type ImageQuality,
  resolveImageOutput,
} from "@codeden/providers";
import type { SettingsStore } from "../../settings-store";
import type { FileReset } from "../../user-json-file";
import type { ArtifactService } from "../artifacts";
import { badRequest, errorMessage, ServiceError } from "../errors";
import type { SessionRepo } from "../sessions/repo";
import { sessionWorkdir } from "../sessions/workdir";
import { ImageUsageStore } from "./usage";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const AVAILABILITY_TTL_MS = 5 * 60_000;
const TEST_PROMPT =
  "A small flat illustration of a friendly fox sitting at a laptop, simple shapes.";

export interface ImageServiceDeps {
  registry: ImageEngineRegistry;
  settings: SettingsStore;
  artifacts: ArtifactService;
  repo: SessionRepo;
  /** `<home>/image-usage.json`. */
  usageFile: string;
  /** Told when a damaged usage file was kept as a copy and today's counts reset. */
  onUsageReset?: (reset: FileReset) => void;
  /** `<home>/generated`: output for roles without a worktree and for the test button. */
  generatedDir: string;
  log?: (message: string) => void;
}

export interface GenerateImagesRequest {
  sessionId: string;
  role: Role;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  size?: string;
  quality?: ImageQuality;
  count?: number;
  referenceImages?: string[];
  outputPath?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  path: string;
  /** Relative to the session's working directory, when inside it. */
  relativePath: string | null;
  artifact: Artifact;
}

export interface GenerateImagesResult {
  images: GeneratedImage[];
  engine: string;
  model: string;
  revisedPrompt?: string;
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Image generation for every agent (§12.5): picks the engine from Settings (with per-project
 * overrides), enforces the daily caps, writes into the session's worktree and stores every
 * image as an artifact. Availability is cached so the tool can be hidden synchronously.
 */
export class ImageService {
  private readonly usage: ImageUsageStore;
  private available: boolean | undefined;
  private checkedAt = 0;
  private refreshing: Promise<boolean> | undefined;

  constructor(private readonly deps: ImageServiceDeps) {
    this.usage = new ImageUsageStore(deps.usageFile, undefined, deps.onUsageReset);
  }

  /** Global settings with the project's override applied. */
  effective(projectId: string | null | undefined) {
    const global = this.deps.settings.get().imageGeneration;
    const override = projectId ? global.projects[projectId] : undefined;
    return {
      engine: override?.engine ?? global.engine,
      defaultSize: override?.defaultSize ?? global.defaultSize,
      quality: override?.quality ?? global.quality,
      globalCap: global.dailyCap,
      projectCap: override?.dailyCap,
    };
  }

  /** Cached: can any configured engine run? Refreshes in the background when stale. */
  availableNow(): boolean {
    if (Date.now() - this.checkedAt > AVAILABILITY_TTL_MS) void this.refresh();
    return this.available === true;
  }

  /** Forget the cached availability (settings or API keys changed) and re-check. */
  invalidate(): void {
    this.checkedAt = 0;
    void this.refresh();
  }

  refresh(): Promise<boolean> {
    this.refreshing ??= this.detectAny()
      .then((available) => {
        this.available = available;
        this.checkedAt = Date.now();
        return available;
      })
      .catch((error: unknown) => {
        this.deps.log?.(`images: detection failed: ${errorMessage(error)}`);
        this.available = false;
        this.checkedAt = Date.now();
        return false;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  async engines(projectId?: string): Promise<ImageEnginesResponse> {
    const detected = await this.deps.registry.detectAll();
    const pick = await this.pick(this.effective(projectId).engine);
    const eff = this.effective(projectId);
    return {
      engines: this.deps.registry.list().map((e) => ({
        id: e.id,
        label: e.label,
        available: detected.get(e.id)?.available ?? false,
        reason: detected.get(e.id)?.reason,
        requiresApiKey: e.capabilities.requiresApiKey,
        referenceImages: e.capabilities.referenceImages,
        exactSize: e.capabilities.exactSize,
        defaultModel: e.defaultModel,
      })),
      active: pick.engine ? { engine: pick.engine.id } : { engine: null, reason: pick.reason },
      usage: this.usage.today(),
      dailyCap: Math.min(eff.globalCap, eff.projectCap ?? Number.POSITIVE_INFINITY),
    };
  }

  /** Run the `generate_image` tool for a session. */
  async generate(req: GenerateImagesRequest): Promise<GenerateImagesResult> {
    const session = this.deps.repo.get(req.sessionId);
    const eff = this.effective(session.projectId);
    const pick = await this.pick(eff.engine);
    if (!pick.engine) throw new ServiceError(409, "no_image_engine", pick.reason);
    const cwd = realpathSync(sessionWorkdir(session));
    // Agents write into their worktree; PMs and the orchestrator never write project files.
    const root =
      req.role === "agent" ? cwd : this.ensureDir(join(this.deps.generatedDir, session.id));
    let target: { outputDir: string; fileStem: string };
    try {
      target = resolveImageOutput(root, req.outputPath);
    } catch (error) {
      throw badRequest(errorMessage(error), "invalid_output_path");
    }
    this.assertNoEscape(root, target.outputDir);
    const references = (req.referenceImages ?? []).map((p) => this.referencePath(cwd, p));
    if (references.length > 0 && !pick.engine.capabilities.referenceImages) {
      throw badRequest(`${pick.engine.label} does not accept reference images`);
    }
    const count = req.count ?? 1;
    const caps = { global: eff.globalCap, project: eff.projectCap };
    this.usage.reserve(count, caps, session.projectId);
    let produced = 0;
    try {
      const result = await pick.engine.generate({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        size: req.size ?? (req.aspectRatio ? undefined : eff.defaultSize),
        quality: req.quality ?? eff.quality,
        count,
        referenceImages: references,
        outputDir: target.outputDir,
        fileStem: target.fileStem,
        signal: req.signal,
      });
      produced = result.files.length;
      const images = result.files.map((file) => ({
        path: file,
        relativePath: isInside(cwd, file) ? relative(cwd, file).split("\\").join("/") : null,
        artifact: this.saveArtifact(file, session.projectId, session.id),
      }));
      return {
        images,
        engine: result.engine,
        model: result.model,
        revisedPrompt: result.revisedPrompt,
      };
    } catch (error) {
      throw toServiceError(error);
    } finally {
      this.usage.release(count - produced, session.projectId);
    }
  }

  /** The Settings "test" button. Never throws for engine failures; reports them instead. */
  async test(req: ImageTestRequest): Promise<ImageTestResponse> {
    const started = Date.now();
    const choice = req.engine ?? this.effective(req.projectId).engine;
    const pick = await this.pick(choice);
    const elapsed = () => Date.now() - started;
    if (!pick.engine) {
      return {
        ok: false,
        engine: null,
        durationMs: elapsed(),
        error: { code: "no_image_engine", message: pick.reason },
      };
    }
    const engine = pick.engine;
    if (req.generate === false) return { ok: true, engine: engine.id, durationMs: elapsed() };
    const eff = this.effective(req.projectId);
    const outputDir = this.ensureDir(join(this.deps.generatedDir, "test"));
    try {
      this.usage.reserve(1, { global: eff.globalCap, project: eff.projectCap }, null);
      const result = await engine.generate({
        prompt: req.prompt ?? TEST_PROMPT,
        aspectRatio: "1:1",
        quality: "low",
        count: 1,
        outputDir,
        fileStem: `test-${Date.now()}`,
      });
      const file = result.files[0];
      if (!file) throw new ImageGenerationError("no_image", engine.id, "No image was returned");
      const artifact = this.saveArtifact(file, req.projectId ?? null, null);
      rmSync(file, { force: true });
      return { ok: true, engine: engine.id, model: result.model, durationMs: elapsed(), artifact };
    } catch (error) {
      if (!(error instanceof ServiceError)) this.usage.release(1, null);
      const mapped = toServiceError(error);
      return {
        ok: false,
        engine: engine.id,
        durationMs: elapsed(),
        error: { code: mapped.code, message: mapped.message },
      };
    }
  }

  private async pick(choice: ImageEngineSetting) {
    return this.deps.registry.pickDefault({ engine: choice });
  }

  private async detectAny(): Promise<boolean> {
    const { engine, projects } = this.deps.settings.get().imageGeneration;
    const choices = new Set<ImageEngineSetting>([engine]);
    for (const o of Object.values(projects)) if (o.engine) choices.add(o.engine);
    for (const choice of choices) {
      if ((await this.pick(choice)).engine) return true;
    }
    return false;
  }

  private saveArtifact(file: string, projectId: string | null, sessionId: string | null) {
    return this.deps.artifacts.save({
      bytes: readFileSync(file),
      name: basename(file),
      mediaType: MEDIA_TYPES[extname(file).toLowerCase()] ?? "image/png",
      kind: "image",
      projectId,
      sessionId,
    });
  }

  private ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }

  /** The nearest existing ancestor of the output folder must resolve inside the root. */
  private assertNoEscape(root: string, outputDir: string): void {
    let dir = outputDir;
    while (!existsSync(dir) && dir !== resolve(dir, "..")) dir = resolve(dir, "..");
    if (!isInside(root, realpathSync(dir))) {
      throw badRequest("The output path must stay inside your worktree", "invalid_output_path");
    }
  }

  private referencePath(cwd: string, path: string): string {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw badRequest(`Reference image not found: ${path}`, "reference_not_found");
    }
    const real = realpathSync(absolute);
    const roots = [cwd, tmpdir(), this.deps.artifacts.rootDir]
      .filter(existsSync)
      .map((p) => realpathSync(p));
    if (!roots.some((r) => isInside(r, real))) {
      throw badRequest(
        "Reference images must be inside your working directory, the temp folder or CodeDen's artifacts",
        "reference_outside",
      );
    }
    return real;
  }
}

function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ImageGenerationError) {
    const retry = error.details.retryAfter
      ? ` Try again after ${error.details.retryAfter.toISOString()}.`
      : "";
    const status = error.code === "invalid_request" || error.code === "content_policy" ? 400 : 502;
    return new ServiceError(status, `image_${error.code}`, `${error.message}${retry}`);
  }
  return new ServiceError(502, "image_failed", errorMessage(error));
}
