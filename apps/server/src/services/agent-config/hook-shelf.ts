import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ShelvedHook } from "@codeden/contracts";
import { z } from "zod";
import { notFound, ServiceError } from "../errors";
import { atomicWrite } from "./files";

const ShelfFile = z.object({ hooks: z.array(ShelvedHook) });

/**
 * CodeDen's shelf for disabled hooks (§12.4): Claude Code has no per-hook switch, so "disable"
 * takes a hook out of its settings file and keeps it here until it is enabled or removed.
 * One JSON file (`{ "hooks": ShelvedHook[] }`), written atomically.
 */
export class HookShelf {
  constructor(readonly file: string) {}

  /** Everything on the shelf; an unreadable shelf lists as empty (writes still refuse). */
  list(): ShelvedHook[] {
    try {
      return this.read();
    } catch {
      return [];
    }
  }

  get(id: string): ShelvedHook {
    const found = this.read().find((h) => h.id === id);
    if (!found) throw notFound("That disabled hook is no longer on the shelf", "hook_not_found");
    return found;
  }

  add(entry: Omit<ShelvedHook, "id" | "disabledAt">): ShelvedHook {
    const hooks = this.read();
    const shelved = { ...entry, id: randomUUID(), disabledAt: new Date().toISOString() };
    this.write([...hooks, shelved]);
    return shelved;
  }

  remove(id: string): void {
    const hooks = this.read();
    if (!hooks.some((h) => h.id === id)) {
      throw notFound("That disabled hook is no longer on the shelf", "hook_not_found");
    }
    this.write(hooks.filter((h) => h.id !== id));
  }

  private read(): ShelvedHook[] {
    if (!existsSync(this.file)) return [];
    try {
      return ShelfFile.parse(JSON.parse(readFileSync(this.file, "utf8"))).hooks;
    } catch {
      throw new ServiceError(422, "shelf_unreadable", `${this.file} could not be read`);
    }
  }

  private write(hooks: ShelvedHook[]): void {
    atomicWrite(this.file, `${JSON.stringify({ hooks }, null, 2)}\n`);
  }
}
