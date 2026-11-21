import {
  GROUP_MEMORY_MAX_BYTES,
  type GroupMemory,
  type MemoryWriteMode,
  type MemoryWriter,
  nextMemoryContent,
  type ProjectGroup,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectGroupMemory } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { conflict, ServiceError } from "../errors";

export interface MemoryWrite {
  content: string;
  mode: MemoryWriteMode;
  /** Refuse the write when the memory's revision is no longer this one. */
  baseRevision?: number;
}

/**
 * A group's shared memory (DESIGN.md "Project groups"), the group counterpart of the PM's
 * project notes: Markdown, read whole, written by `append` or `replace`, at most 200 KB.
 *
 * Several projects' PMs and agents write to it. Each write is a `project_group.memory_written`
 * event that the projection applies to the content as it is at that moment, inside the append
 * transaction, so concurrent appends never lose one another. The revision check and the append
 * run in one synchronous call on the server's single database connection, so nothing can land
 * between them; a `replace` with a stale `baseRevision` is refused rather than overwriting a
 * write its author never saw.
 */
export class GroupMemoryStore {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly group: (id: string) => ProjectGroup,
  ) {}

  read(groupId: string): GroupMemory {
    this.group(groupId);
    const row = this.db
      .select()
      .from(projectGroupMemory)
      .where(eq(projectGroupMemory.groupId, groupId))
      .get();
    return row
      ? { groupId, content: row.content, revision: row.revision, updatedAt: row.updatedAt }
      : { groupId, content: "", revision: 0, updatedAt: null };
  }

  write(groupId: string, write: MemoryWrite, by: MemoryWriter): GroupMemory {
    const current = this.read(groupId);
    if (write.baseRevision !== undefined && write.baseRevision !== current.revision) {
      throw conflict(
        `The group memory changed since revision ${write.baseRevision} (now ${current.revision}); read it again and reapply your change`,
        "memory_changed",
      );
    }
    const next = nextMemoryContent(current.content, write.content, write.mode);
    if (Buffer.byteLength(next, "utf8") > GROUP_MEMORY_MAX_BYTES) {
      throw new ServiceError(413, "memory_too_large", "Group memory is limited to 200 KB");
    }
    const revision = current.revision + 1;
    this.store.append([
      {
        type: "project_group.memory_written",
        sessionId: null,
        payload: { groupId, mode: write.mode, content: write.content, revision, by },
      },
    ]);
    return this.read(groupId);
  }
}
