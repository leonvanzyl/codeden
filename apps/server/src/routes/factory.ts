import {
  FactoryAdmitRequest,
  FactoryDismissRequest,
  type FactoryItemResponse,
  FactoryRetryOptions,
  FactorySetTypeRequest,
  KillSwitchRequest,
  PutVisionRequest,
  SetAutonomyModeRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

/**
 * `/api/projects/:id/...`: autonomy mode, vision, the factory panel and its controls (§10.1).
 * Mounted under `/projects`. `factory/scout` is "Run scout now": 409 `scout_unavailable` with
 * the reason when no round can start. `kill-switch` takes `mode` (`now`, the default, or
 * `drain`: finish the work in flight, then stop); `factory/resume` also cancels a drain.
 */
export function projectFactoryRoutes(s: AppServices) {
  const f = s.factory;
  return new Hono()
    .get("/:id/factory", async (c) => c.json(await f.status(c.req.param("id"))))
    .put("/:id/autonomy", jsonBody(SetAutonomyModeRequest), async (c) =>
      c.json(await f.setMode(c.req.param("id"), c.req.valid("json"))),
    )
    .get("/:id/vision", (c) => c.json(f.vision(c.req.param("id"))))
    .put("/:id/vision", jsonBody(PutVisionRequest), async (c) =>
      c.json(await f.putVision(c.req.param("id"), c.req.valid("json").contents)),
    )
    .post("/:id/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
      const { on, mode, drainLimitMin } = c.req.valid("json");
      return c.json(await f.setKillSwitch(c.req.param("id"), on, { mode, drainLimitMin }));
    })
    .post("/:id/factory/resume", async (c) => c.json(await f.resume(c.req.param("id"))))
    .post("/:id/factory/tick", async (c) => {
      await f.tick(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/scout", async (c) => {
      await f.runScout(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/digest", async (c) => c.json(await f.digestNow(c.req.param("id"))))
    .get("/:id/factory/items/:itemId", (c) =>
      c.json<FactoryItemResponse>({ item: f.item(c.req.param("id"), c.req.param("itemId")) }),
    )
    .post("/:id/factory/admit", jsonBody(FactoryAdmitRequest), async (c) =>
      c.json<FactoryItemResponse>({
        item: await f.admit(c.req.param("id"), c.req.valid("json"), "user"),
      }),
    )
    .post("/:id/factory/set-type", jsonBody(FactorySetTypeRequest), async (c) =>
      c.json<FactoryItemResponse>({
        item: await f.setType(c.req.param("id"), c.req.valid("json"), "user"),
      }),
    )
    .post("/:id/factory/items/:itemId/retry", jsonBody(FactoryRetryOptions), (c) =>
      c.json<FactoryItemResponse>({
        item: f.retry(c.req.param("id"), c.req.param("itemId"), c.req.valid("json").mode),
      }),
    )
    .post("/:id/factory/items/:itemId/dismiss", jsonBody(FactoryDismissRequest), (c) =>
      c.json<FactoryItemResponse>({
        item: f.dismiss(c.req.param("id"), c.req.param("itemId"), c.req.valid("json"), "user"),
      }),
    );
}

/** `/api/factory`: the global kill switch (Stop now only: 400 `drain_per_project` for a drain). */
export function factoryRoutes(s: AppServices) {
  return new Hono().post("/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
    const { on, mode } = c.req.valid("json");
    return c.json(await s.factory.setGlobalKillSwitch(on, mode));
  });
}
