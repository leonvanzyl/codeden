import { type TechDebtAction, TechDebtActionResult, TechDebtList } from "@codeden/contracts";
import type { Fetcher } from "./http";

export interface TechDebtApi {
  list(projectId: string): Promise<TechDebtList>;
  act(projectId: string, action: TechDebtAction): Promise<TechDebtActionResult>;
}

export function httpTechDebtApi(http: Fetcher): TechDebtApi {
  const path = (id: string) => `/projects/${encodeURIComponent(id)}/tech-debt`;
  return {
    list: (id) => http.get(path(id), TechDebtList.parse),
    act: (id, action) => http.post(path(id), action, TechDebtActionResult.parse),
  };
}
