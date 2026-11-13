import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImageEnginesResponse, ImageTestResponse, SessionSnapshot } from "@codeden/contracts";
import {
  type ImageEngine,
  type ImageEngineAvailability,
  ImageEngineRegistry,
  type ImageGenerateRequest,
} from "@codeden/providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A keyless engine that writes 1x1 PNGs, standing in for Codex. */
class FakeImageEngine implements ImageEngine {
  readonly id = "codex" as const;
  readonly label = "Fake Codex";
  readonly capabilities = { referenceImages: true, exactSize: false, requiresApiKey: false };
  readonly defaultModel = "fake-image";
  readonly requests: ImageGenerateRequest[] = [];
  availability: ImageEngineAvailability = { available: true };

  async detect() {
    return this.availability;
  }

  async generate(request: ImageGenerateRequest) {
    this.requests.push(request);
    mkdirSync(request.outputDir, { recursive: true });
    const files = Array.from({ length: request.count ?? 1 }, (_, i) => {
      const file = join(
        request.outputDir,
        `${request.fileStem ?? "image"}${i ? `-${i + 1}` : ""}.png`,
      );
      writeFileSync(file, PNG);
      return file;
    });
    return { files, engine: this.id, model: this.defaultModel };
  }
}

describe("generate_image and the image settings", () => {
  let h: Harness;
  let engine: FakeImageEngine;
  let sessionId: string;
  let mcp: Client;

  beforeAll(async () => {
    engine = new FakeImageEngine();
    h = await startHarness({ imageEngines: new ImageEngineRegistry([engine]) });
    sessionId = await h.startFakeSession();
    await h.server.services.images.refresh();
    const token = h.server.services.mcpTokens.mint({
      role: "agent",
      sessionId,
      projectId: h.projectId,
    });
    mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(h.server.runner?.mcpProxyUrl as string), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterAll(async () => {
    await mcp?.close();
    await h?.close();
  });

  const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    (r.content as Array<{ text?: string }>)[0]?.text ?? "";

  it("writes into the worktree, stores artifacts and shares them in the chat", async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain("generate_image");

    const result = await mcp.callTool({
      name: "generate_image",
      arguments: { prompt: "A hero image", outputPath: "public/hero.png", count: 2 },
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("public/hero.png");
    expect(text(result)).toContain("public/hero-2.png");
    const session = (await h.detail(sessionId)).session;
    const root = session.worktreePath ?? session.cwd;
    expect(existsSync(join(root, "public", "hero.png"))).toBe(true);
    expect(engine.requests[0]).toMatchObject({
      prompt: "A hero image",
      count: 2,
      size: "1024x1024",
    });

    const images = h.server.services.artifacts
      .list({ sessionId })
      .filter((a) => a.kind === "image");
    expect(images).toHaveLength(2);
    const snapshot = SessionSnapshot.parse(
      (await h.api("GET", `/sessions/${sessionId}/snapshot`)).body,
    );
    const shared = snapshot.items.filter(
      (r) => r.item.kind === "notice" && r.item.code === "shared_artifact",
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses output paths outside the worktree and missing references", async () => {
    const escaping = await mcp.callTool({
      name: "generate_image",
      arguments: { prompt: "x", outputPath: "../outside.png" },
    });
    expect(escaping.isError).toBe(true);
    expect(text(escaping)).toMatch(/inside the worktree/);
    const missing = await mcp.callTool({
      name: "generate_image",
      arguments: { prompt: "x", referenceImages: ["nope.png"] },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/Reference image not found/);
  });

  it("enforces the daily cap and the project's own cap", async () => {
    const total = (await h.server.services.images.engines()).usage.total;
    await h.api("PATCH", "/settings", { imageGeneration: { dailyCap: total + 1 } });
    expect(
      (await mcp.callTool({ name: "generate_image", arguments: { prompt: "a" } })).isError,
    ).toBeFalsy();
    const capped = await mcp.callTool({ name: "generate_image", arguments: { prompt: "b" } });
    expect(capped.isError).toBe(true);
    expect(text(capped)).toMatch(/daily image cap/);

    await h.api("PATCH", "/settings", {
      imageGeneration: { dailyCap: 100, projects: { [h.projectId]: { dailyCap: 0 } } },
    });
    const projectCapped = await mcp.callTool({
      name: "generate_image",
      arguments: { prompt: "c" },
    });
    expect(text(projectCapped)).toMatch(/project's daily image cap/);
    const res = await h.api("PATCH", "/settings", {
      imageGeneration: { projects: { [h.projectId]: null } },
    });
    expect(res.status).toBe(200);
    expect(h.server.services.settings.get().imageGeneration.projects).toEqual({});
  });

  it("lists engines and runs the settings test", async () => {
    const engines = ImageEnginesResponse.parse(
      (await h.api("GET", `/images/engines?projectId=${h.projectId}`)).body,
    );
    expect(engines.active).toEqual({ engine: "codex" });
    expect(engines.engines[0]).toMatchObject({ id: "codex", available: true });
    const test = ImageTestResponse.parse((await h.api("POST", "/images/test", {})).body);
    expect(test).toMatchObject({ ok: true, engine: "codex", model: "fake-image" });
    expect(test.artifact?.mediaType).toBe("image/png");
  });

  it("hides the tool when no engine is available", async () => {
    await h.api("PATCH", "/settings", { imageGeneration: { engine: "none" } });
    await h.server.services.images.refresh();
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain("generate_image");
    const test = ImageTestResponse.parse((await h.api("POST", "/images/test", {})).body);
    expect(test).toMatchObject({ ok: false, engine: null, error: { code: "no_image_engine" } });
    await h.api("PATCH", "/settings", { imageGeneration: { engine: "auto" } });
    engine.availability = { available: false, reason: "Not logged in" };
    await h.server.services.images.refresh();
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain("generate_image");
    engine.availability = { available: true };
  });
});
