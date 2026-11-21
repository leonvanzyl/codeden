import {
  type CreateGroupRequest,
  DeleteGroupResponse,
  GroupMemoryResponse,
  GroupResponse,
  type MemoryWriteMode,
  type UpdateGroupRequest,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

/**
 * `/api/groups/*`: project groups with their shared skills and memory. A project joins or
 * leaves a group through `updateProject({ groupId })`. A memory write with a stale
 * `baseRevision` rejects with a 409 `memory_changed` `ApiRequestError`.
 */
export interface GroupsApi {
  create(req: CreateGroupRequest): Promise<GroupResponse["group"]>;
  /** `skills` replaces the whole list. */
  update(groupId: string, req: UpdateGroupRequest): Promise<GroupResponse["group"]>;
  /** The member projects are taken out of the group and the memory is deleted. */
  remove(groupId: string): Promise<DeleteGroupResponse>;
  memory(groupId: string): Promise<GroupMemoryResponse["memory"]>;
  writeMemory(
    groupId: string,
    req: { content: string; mode?: MemoryWriteMode; baseRevision?: number },
  ): Promise<GroupMemoryResponse["memory"]>;
}

export function httpGroupsApi(http: Fetcher): GroupsApi {
  const path = (id: string) => `/groups/${encodeURIComponent(id)}`;
  return {
    create: (req) => http.post("/groups", req, (v) => GroupResponse.parse(v).group),
    update: (id, req) => http.call("PATCH", path(id), req, (v) => GroupResponse.parse(v).group),
    remove: (id) => http.call("DELETE", path(id), undefined, (v) => DeleteGroupResponse.parse(v)),
    memory: (id) => http.get(`${path(id)}/memory`, (v) => GroupMemoryResponse.parse(v).memory),
    writeMemory: (id, req) =>
      http.call("PUT", `${path(id)}/memory`, req, (v) => GroupMemoryResponse.parse(v).memory),
  };
}
