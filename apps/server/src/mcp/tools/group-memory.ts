import { MemoryWriteMode } from "@codeden/contracts";
import { z } from "zod";
import type { AppServices } from "../../services/container";
import { defineTool, type ToolAvailabilityContext, ToolError } from "../define";
import { memorySource, memoryWrite } from "./shared/memory-writes";

/** Listed only to PMs and agents of a project that is in a group. */
const inGroup = (services: AppServices, caller?: ToolAvailabilityContext) =>
  Boolean(caller?.projectId && services.groups.groupOf(caller.projectId));

/** `read_group_memory` (DESIGN.md "Project groups"): the memory the group's projects share. */
export const readGroupMemory = defineTool({
  name: "read_group_memory",
  description:
    "Read your project group's shared memory: facts that hold for every project in the group, written by the PMs and agents of all of them. Project-specific facts are in read_project_notes. The first line names the group id and the revision, which a replace needs.",
  roles: ["pm", "agent"],
  scope: "project",
  isAvailable: inGroup,
  input: z.object({}),
  handler: async (_input, { services, projectId }) => {
    const { group, memory } = services.groups.readMemoryFor(projectId);
    const header = `Group "${group.name}" (groupId ${group.id}), revision ${memory.revision}`;
    return memory.content.trim() ? `${header}\n\n${memory.content}` : `${header}: (no memory yet)`;
  },
});

/**
 * `update_group_memory`: safe with several projects writing (see `GroupMemoryStore`). A replace
 * names the group and revision it read, so it never lands on a group the project moved to since.
 */
export const updateGroupMemory = defineTool({
  name: "update_group_memory",
  description:
    "Write to your project group's shared memory, for facts that hold across the group's projects (shared conventions, services, decisions). Project-specific facts go to update_project_notes instead; never write secrets. mode 'append' (default) adds a section and never loses another project's write. 'replace' (project managers only) rewrites the whole memory and needs the groupId and baseRevision from read_group_memory; it is refused if anyone wrote in between.",
  roles: ["pm", "agent"],
  scope: "project",
  isAvailable: inGroup,
  input: z
    .object({
      content: z.string().min(1).max(100_000),
      mode: MemoryWriteMode.optional(),
      groupId: z.string().min(1).optional(),
      baseRevision: z.int().nonnegative().optional(),
    })
    .refine(
      (v) => v.mode !== "replace" || (v.baseRevision !== undefined && v.groupId !== undefined),
      { message: "replace needs groupId and baseRevision: read_group_memory first" },
    ),
  handler: async (input, { services, projectId, sessionId, role }) => {
    const mode = input.mode ?? "append";
    const caller = { role, sessionId };
    const text = await memoryWrite(services, caller, input.content, mode);
    const content = `${memorySource(services, projectId, caller)}\n\n${text.trim()}`;
    const current = services.groups.groupOf(projectId);
    if (input.groupId && current && input.groupId !== current.id) {
      throw new ToolError(
        `This project is now in the group "${current.name}", not the one you read; read_group_memory again.`,
      );
    }
    const { group, memory } = services.groups.writeMemoryFor(projectId, sessionId, {
      content,
      mode,
      baseRevision: input.baseRevision,
    });
    const size = Buffer.byteLength(memory.content, "utf8");
    return `Group "${group.name}" memory saved (revision ${memory.revision}, ${size} bytes).`;
  },
});
