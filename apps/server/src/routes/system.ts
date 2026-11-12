import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import {
  FileReadQuery,
  FileWriteRequest,
  LoginToolId,
  type RefreshModelsResponse,
  SecretKey,
  type SecretsStatus,
  SetSecretRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { badRequest } from "../services/errors";
import { listDirectories } from "../services/files/fs-browser";
import { refreshProviderModels } from "../services/runner-port";
import { jsonBody, queryOf } from "./validate";

/** `/api/setup`: first-run detection, login commands, Claude Code support, completion (§14). */
export function setupRoutes(s: AppServices) {
  return new Hono()
    .get("/status", queryOf(z.object({ refresh: z.enum(["1", "true"]).optional() })), async (c) =>
      c.json(await s.setup.status({ refresh: c.req.valid("query").refresh !== undefined })),
    )
    .post("/login/:tool", (c) => {
      const tool = LoginToolId.safeParse(c.req.param("tool"));
      if (!tool.success) throw badRequest("Unknown tool", "unknown_tool");
      return c.json(s.setup.loginCommand(tool.data));
    })
    .get("/claude-sdk", (c) => c.json(s.claudeSdk.status()))
    .post("/claude-sdk/install", (c) => c.json(s.claudeSdk.install()))
    .post("/complete", (c) => {
      const setupCompleted = s.setup.complete();
      // Other tabs and fresh snapshots learn about it like any other settings change.
      s.store.append([
        { type: "settings.updated", sessionId: null, payload: { settings: s.settings.get() } },
      ]);
      return c.json({ setupCompleted });
    });
}

/** `/api/providers`: the runner's providers. Their model lists arrive with the runner status. */
export function providerRoutes(s: AppServices) {
  return new Hono().post("/:id/refresh-models", async (c) => {
    const body: RefreshModelsResponse = await refreshProviderModels(s.runner, c.req.param("id"));
    return c.json(body);
  });
}

/** `/api/fs` (folder picker) and `/api/files` (config editors). */
export function fileRoutes(s: AppServices) {
  return new Hono()
    .get(
      "/fs/list",
      queryOf(
        z.object({ path: z.string().optional(), showHidden: z.enum(["1", "true"]).optional() }),
      ),
      (c) => {
        const q = c.req.valid("query");
        return c.json(
          listDirectories(q.path, { showHidden: q.showHidden !== undefined, home: s.userHome }),
        );
      },
    )
    .get("/files", queryOf(FileReadQuery), (c) => c.json(s.configFiles.read(c.req.valid("query"))))
    .put("/files", jsonBody(FileWriteRequest), (c) =>
      c.json(s.configFiles.write(c.req.valid("json"))),
    );
}

/** `/api/artifacts`: list and serve stored files safely. */
export function artifactRoutes(s: AppServices) {
  return new Hono()
    .get(
      "/",
      queryOf(z.object({ sessionId: z.string().optional(), projectId: z.string().optional() })),
      (c) => c.json(s.artifacts.list(c.req.valid("query"))),
    )
    .get("/:id/meta", (c) => c.json(s.artifacts.get(c.req.param("id"))))
    .get("/:id", (c) => {
      const artifact = s.artifacts.get(c.req.param("id"));
      const file = s.artifacts.filePath(artifact);
      const size = statSync(file).size;
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(artifact.mediaType);
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
      return c.body(stream, 200, {
        "content-type": inline ? artifact.mediaType : "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.name.replace(/["\\\r\n]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      });
    });
}

/** `/api/secrets`: which keychain secrets are set; set and delete. Values are never returned. */
export function secretRoutes(s: AppServices) {
  const keyParam = (raw: string) => {
    const key = SecretKey.safeParse(raw);
    if (!key.success) throw badRequest("Unknown secret", "unknown_secret");
    return key.data;
  };
  return new Hono()
    .get("/", async (c) => {
      const keys = await Promise.all(
        SecretKey.options.map(async (key) => ({ key, set: (await s.secrets.get(key)) !== null })),
      );
      const body: SecretsStatus = { backend: s.secrets.backend, keys };
      return c.json(body);
    })
    .put("/:key", jsonBody(SetSecretRequest), async (c) => {
      await s.secrets.set(keyParam(c.req.param("key")), c.req.valid("json").value);
      s.images.invalidate();
      return c.json({ ok: true as const });
    })
    .delete("/:key", async (c) => {
      await s.secrets.delete(keyParam(c.req.param("key")));
      s.images.invalidate();
      return c.json({ ok: true as const });
    });
}
