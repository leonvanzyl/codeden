import {
  type FactoryAdmitRequest,
  FactoryDigest,
  type FactoryDismissRequest,
  type FactoryItem,
  FactoryItemResponse,
  FactoryLoop,
  type FactoryRetryOptions,
  type FactorySetTypeRequest,
  FactoryStatus,
  type KillSwitchMode,
  type KillSwitchRequestInit,
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
  /**
   * The project's kill switch, or every project's with `"global"`. On stops now by default;
   * `mode: "drain"` (a project's only) finishes the work in flight, then stops, optionally within
   * `drainLimitMin`. Off releases the switch and cancels a drain.
   */
  killSwitch(
    scope: { projectId: string } | "global",
    on: boolean,
    opts?: { mode?: KillSwitchMode; drainLimitMin?: number | null },
  ): Promise<KillSwitchResponse>;
  /** Clear a pause and the failure count, and cancel a drain. */
  resume(projectId: string): Promise<FactoryLoop>;
  /** Run one loop step now ("Check now"); returns the fresh status. */
  tick(projectId: string): Promise<FactoryStatus>;
  /**
   * Dark factory: start a scout round now, skipping the interval and the backlog threshold;
   * returns the fresh status. 409 `scout_unavailable` says why it can't (as
   * `status.scout.runNowBlockedBy` does).
   */
  runScout(projectId: string): Promise<FactoryStatus>;
  /** Today's digest, now (also raised in the inbox). */
  digest(projectId: string): Promise<FactoryDigest>;
  /** Let an issue from an untrusted author in (it is never merged automatically). */
  admit(projectId: string, req: FactoryAdmitRequest): Promise<FactoryItem>;
  /** Move an item that hasn't started to another pipeline. */
  setType(projectId: string, req: FactorySetTypeRequest): Promise<FactoryItem>;
  /**
   * Run a stopped item again: with its PR open, a fresh review of that PR (`rereview`, the
   * default then); otherwise, or with `rebuild`, from the first step. 409 `no_open_pr` when a
   * re-review is asked for without an open PR.
   */
  retry(projectId: string, itemId: string, opts?: FactoryRetryOptions): Promise<FactoryItem>;
  /**
   * Dismiss a failed item without an open PR: it is rejected with the reason. 409 `pr_open`
   * while its PR is open, `not_failed` for other stages.
   */
  dismiss(projectId: string, itemId: string, req?: FactoryDismissRequest): Promise<FactoryItem>;
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
    killSwitch: (scope, on, opts = {}) =>
      post(
        scope === "global" ? "/factory/kill-switch" : `${p(scope.projectId)}/kill-switch`,
        { on, ...opts } satisfies KillSwitchRequestInit,
        (v) => KillSwitchResponse.parse(v),
      ),
    resume: (id) => post(`${p(id)}/factory/resume`, {}, (v) => FactoryLoop.parse(v)),
    tick: (id) => post(`${p(id)}/factory/tick`, {}, (v) => FactoryStatus.parse(v)),
    runScout: (id) => post(`${p(id)}/factory/scout`, {}, (v) => FactoryStatus.parse(v)),
    digest: (id) => post(`${p(id)}/factory/digest`, {}, (v) => FactoryDigest.parse(v)),
    admit: (id, req) => post(`${p(id)}/factory/admit`, req, item),
    setType: (id, req) => post(`${p(id)}/factory/set-type`, req, item),
    retry: (id, itemId, opts) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/retry`, opts ?? {}, item),
    dismiss: (id, itemId, req = {}) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/dismiss`, req, item),
  };
}
