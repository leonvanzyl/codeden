import {
  type FactoryAdmitRequest,
  FactoryDigest,
  type FactoryItem,
  FactoryItemResponse,
  FactoryLoop,
  type FactorySetTypeRequest,
  FactoryStatus,
  KillSwitchResponse,
  type SetAutonomyModeRequestInit,
  SetAutonomyModeResponse,
  VisionResponse,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

/**
 * `/api/projects/:id/{autonomy,vision,kill-switch,factory/*}` and `/api/factory/kill-switch`
 * (§10.1, experimental): autonomy modes, the vision, the software/dark factory panel, its
 * items and controls.
 */
export interface FactoryApi {
  status(projectId: string): Promise<FactoryStatus>;
  item(projectId: string, itemId: string): Promise<FactoryItem>;
  /**
   * Switch mode (and save limits). Factory modes need a GitHub project (409
   * `not_a_github_project`), a vision file (409 `vision_required`) and limits with a daily
   * budget (400 `limits_required` / `budget_required`).
   */
  setMode(projectId: string, req: SetAutonomyModeRequestInit): Promise<SetAutonomyModeResponse>;
  /** The vision; the template with `exists: false` when the file is missing. */
  vision(projectId: string): Promise<VisionResponse>;
  saveVision(projectId: string, contents: string): Promise<VisionResponse>;
  /** The project's kill switch, or every project's with `"global"`. */
  killSwitch(scope: { projectId: string } | "global", on: boolean): Promise<KillSwitchResponse>;
  /** Clear a pause and the failure count. */
  resume(projectId: string): Promise<FactoryLoop>;
  /** Run one loop step now; returns the fresh status. */
  tick(projectId: string): Promise<FactoryStatus>;
  /** Today's digest, now (also raised in the inbox). */
  digest(projectId: string): Promise<FactoryDigest>;
  /** Let an issue from an untrusted author in (it is never merged automatically). */
  admit(projectId: string, req: FactoryAdmitRequest): Promise<FactoryItem>;
  /** Move an item that hasn't started to another pipeline. */
  setType(projectId: string, req: FactorySetTypeRequest): Promise<FactoryItem>;
  /** Run a stopped item again. */
  retry(projectId: string, itemId: string): Promise<FactoryItem>;
}

const enc = encodeURIComponent;

export function httpFactoryApi(http: Fetcher): FactoryApi {
  const { get, post, call } = http;
  const p = (id: string) => `/projects/${enc(id)}`;
  const item = (v: unknown) => FactoryItemResponse.parse(v).item;
  return {
    status: (id) => get(`${p(id)}/factory`, (v) => FactoryStatus.parse(v)),
    item: (id, itemId) => get(`${p(id)}/factory/items/${enc(itemId)}`, item),
    setMode: (id, req) =>
      call("PUT", `${p(id)}/autonomy`, req, (v) => SetAutonomyModeResponse.parse(v)),
    vision: (id) => get(`${p(id)}/vision`, (v) => VisionResponse.parse(v)),
    saveVision: (id, contents) =>
      call("PUT", `${p(id)}/vision`, { contents }, (v) => VisionResponse.parse(v)),
    killSwitch: (scope, on) =>
      post(
        scope === "global" ? "/factory/kill-switch" : `${p(scope.projectId)}/kill-switch`,
        { on },
        (v) => KillSwitchResponse.parse(v),
      ),
    resume: (id) => post(`${p(id)}/factory/resume`, {}, (v) => FactoryLoop.parse(v)),
    tick: (id) => post(`${p(id)}/factory/tick`, {}, (v) => FactoryStatus.parse(v)),
    digest: (id) => post(`${p(id)}/factory/digest`, {}, (v) => FactoryDigest.parse(v)),
    admit: (id, req) => post(`${p(id)}/factory/admit`, req, item),
    setType: (id, req) => post(`${p(id)}/factory/set-type`, req, item),
    retry: (id, itemId) => post(`${p(id)}/factory/items/${enc(itemId)}/retry`, {}, item),
  };
}
