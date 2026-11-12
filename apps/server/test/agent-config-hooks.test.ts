import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HookChangeRequest as HookChange, type HookChangeRequest } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookShelf } from "../src/services/agent-config/hook-shelf";
import { AgentConfigHooks } from "../src/services/agent-config/hooks-service";
import { setTopLevelMember } from "../src/services/agent-config/json-edit";
import { ServiceError } from "../src/services/errors";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("JSON top-level member splice", () => {
  const hooks = { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] };

  it("replaces only the member's value and keeps every other byte", () => {
    const text =
      '{\n    "model": "opus",\n    "hooks": {},\n    "permissions": {\n        "allow": [ "Bash(ls)" ]\n    }\n}\n';
    const out = setTopLevelMember(text, "hooks", hooks);
    const [head, tail] = text.split('"hooks": {}');
    expect(out.startsWith(`${head}"hooks": {\n        "Stop": [`)).toBe(true);
    expect(out.endsWith(tail as string)).toBe(true);
    expect(JSON.parse(out)).toEqual({ ...JSON.parse(text), hooks });
  });

  it("follows tabs and CRLF line endings, and appends a missing member last", () => {
    const text = '{\r\n\t"a": 1,\r\n\t"b": [1, 2]\r\n}';
    const out = setTopLevelMember(text, "hooks", hooks);
    expect(
      out.startsWith('{\r\n\t"a": 1,\r\n\t"b": [1, 2],\r\n\t"hooks": {\r\n\t\t"Stop": ['),
    ).toBe(true);
    expect(out.endsWith("\r\n}")).toBe(true);
    expect(out.includes("\n") && !/[^\r]\n/.test(out)).toBe(true);
    expect(JSON.parse(out).hooks).toEqual(hooks);
  });

  it("handles empty and one-line objects, and keys that look alike inside strings", () => {
    expect(JSON.parse(setTopLevelMember("{}\n", "hooks", hooks))).toEqual({ hooks });
    expect(setTopLevelMember('{"a":1}', "hooks", {})).toBe('{"a":1,"hooks":{}}');
    const tricky = '{ "note": "\\"hooks\\": {}", "nested": { "hooks": 1 } }';
    const out = JSON.parse(setTopLevelMember(tricky, "hooks", hooks));
    expect(out).toEqual({ note: '"hooks": {}', nested: { hooks: 1 }, hooks });
  });
});

describe("hooks in Claude Code settings files", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let backups: string;
  let svc: AgentConfigHooks;
  const userFile = () => join(home, ".claude", "settings.json");
  const projectFile = () => join(repo, ".claude", "settings.json");
  const localFile = () => join(repo, ".claude", "settings.local.json");
  const apply = (req: unknown) => svc.apply(HookChange.parse(req));
  const errorCode = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof ServiceError ? `${error.status} ${error.code}` : String(error);
    }
    return "no error";
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-hooks-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    backups = join(dir, "backups");
    mkdirSync(repo, { recursive: true });
    svc = new AgentConfigHooks({
      home,
      project: (id) => ({ id, path: repo }),
      backup: (file) => {
        mkdirSync(backups, { recursive: true });
        const copy = join(backups, `${Date.now()}-${basename(file)}`);
        cpSync(file, copy);
        return copy;
      },
      shelf: new HookShelf(join(dir, "data", "disabled-hooks.json")),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists hooks from the user, project and local files", () => {
    put(
      userFile(),
      JSON.stringify({
        disableAllHooks: true,
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "guard.sh", timeout: 5 },
                { type: "prompt", prompt: "Is it safe?" },
              ],
            },
          ],
          Broken: "not a list",
        },
      }),
    );
    put(
      projectFile(),
      '{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "x" } ] } ] } }',
    );
    put(localFile(), "{ not json");

    const global = svc.list();
    expect(global.sources.map((s) => s.scope)).toEqual(["user"]);
    expect(global.sources[0]?.disableAllHooks).toBe(true);
    expect(global.hooks.map((x) => `${x.event}:${x.matcher}:${x.handler.type}`)).toEqual([
      "PreToolUse:Bash:command",
      "PreToolUse:Bash:prompt",
    ]);
    expect(global.hooks[0]).toMatchObject({ groupIndex: 0, handlerIndex: 0, enabled: true });

    const withProject = svc.list("p1");
    expect(withProject.sources.map((s) => `${s.scope}:${s.exists}:${Boolean(s.error)}`)).toEqual([
      "user:true:false",
      "project:true:false",
      "local:true:true",
    ]);
    expect(withProject.hooks.find((x) => x.scope === "project")).toMatchObject({
      event: "Stop",
      matcher: null,
      projectId: "p1",
    });
  });

  it("adds hooks, creating the file or key and keeping the rest byte for byte", () => {
    const add = (scope: string, event: string, matcher: string | undefined, command: string) =>
      apply({
        action: "add",
        provider: "claude",
        scope,
        projectId: "p1",
        event,
        matcher,
        handler: { type: "command", command },
      });
    const created = add("local", "Stop", undefined, "notify.sh");
    expect(created).toEqual({ file: localFile(), backupPath: null });
    expect(JSON.parse(readFileSync(localFile(), "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }] },
    });

    const original = '{\n    "permissions": {\n        "allow": ["Bash(ls)"]\n    }\n}\n';
    put(projectFile(), original);
    const preview = svc.diff(
      HookChange.parse({
        action: "add",
        provider: "claude",
        scope: "project",
        projectId: "p1",
        event: "PostToolUse",
        matcher: "Edit|Write",
        handler: { type: "command", command: "prettier --write", timeout: 30 },
      }),
    );
    expect(preview).toMatchObject({ changed: true, deletions: 0, exists: true });
    expect(preview.patch).toContain('+    "hooks": {');
    expect(existsSync(backups)).toBe(false);

    const res = add("project", "PostToolUse", "Edit|Write", "prettier --write");
    expect(readFileSync(res.backupPath as string, "utf8")).toBe(original);
    add("project", "PostToolUse", "Edit|Write", "eslint --fix");
    add("project", "PostToolUse", "Bash", "log.sh");
    const text = readFileSync(projectFile(), "utf8");
    expect(
      text.startsWith(
        '{\n    "permissions": {\n        "allow": ["Bash(ls)"]\n    },\n    "hooks"',
      ),
    ).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text).hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write",
        hooks: [
          { type: "command", command: "prettier --write" },
          { type: "command", command: "eslint --fix" },
        ],
      },
      { matcher: "Bash", hooks: [{ type: "command", command: "log.sh" }] },
    ]);
  });

  it("updates in place keeping unknown fields, moves on a new matcher, and removes", () => {
    const handler = {
      type: "command",
      command: "a.sh",
      if: "Bash(git *)",
      statusMessage: "Checking",
    };
    put(
      userFile(),
      `${JSON.stringify(
        {
          model: "opus",
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [handler, { type: "command", command: "b.sh" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const target = {
      provider: "claude",
      scope: "user",
      event: "PreToolUse",
      groupIndex: 0,
      handlerIndex: 0,
      expected: handler,
    };
    const edited = { ...handler, command: "a2.sh", timeout: 10 };
    apply({ action: "update", target, event: "PreToolUse", matcher: "Bash", handler: edited });
    let doc = JSON.parse(readFileSync(userFile(), "utf8"));
    expect(doc.model).toBe("opus");
    expect(doc.hooks.PreToolUse[0].hooks[0]).toEqual(edited);

    // The old handler is no longer what's on disk: refused.
    expect(
      errorCode(() =>
        apply({ action: "update", target, event: "PreToolUse", matcher: "Bash", handler: edited }),
      ),
    ).toBe("409 hook_changed");

    const moved = { ...target, expected: edited };
    apply({
      action: "update",
      target: moved,
      event: "PostToolUse",
      matcher: "Edit",
      handler: edited,
    });
    doc = JSON.parse(readFileSync(userFile(), "utf8"));
    expect(doc.hooks.PreToolUse[0].hooks).toEqual([{ type: "command", command: "b.sh" }]);
    expect(doc.hooks.PostToolUse).toEqual([{ matcher: "Edit", hooks: [edited] }]);

    const removeB = { ...target, expected: { type: "command", command: "b.sh" } };
    apply({ action: "remove", target: removeB });
    doc = JSON.parse(readFileSync(userFile(), "utf8"));
    expect(doc.hooks.PreToolUse).toBeUndefined();
    expect(errorCode(() => apply({ action: "remove", target: removeB }))).toBe(
      "404 hook_not_found",
    );
  });

  it("disables a hook onto the shelf and enables it back into the same file", () => {
    const handler = { type: "command", command: "guard.sh", async: true };
    put(
      projectFile(),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [handler] }] } }, null, 2),
    );
    const target = {
      provider: "claude",
      scope: "project",
      projectId: "p1",
      event: "PreToolUse",
      groupIndex: 0,
      handlerIndex: 0,
      expected: handler,
    };
    const res = apply({ action: "disable", target });
    expect(res.backupPath).toBeTruthy();
    expect(JSON.parse(readFileSync(projectFile(), "utf8")).hooks).toEqual({});

    const listed = svc.list("p1").hooks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ enabled: false, scope: "project", file: projectFile() });
    expect(svc.list().hooks).toHaveLength(0);
    const shelfId = listed[0]?.shelfId as string;

    apply({ action: "enable", target: { shelfId } });
    expect(JSON.parse(readFileSync(projectFile(), "utf8")).hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [handler] }],
    });
    expect(svc.list("p1").hooks.map((h) => h.enabled)).toEqual([true]);

    // Removing a disabled hook only drops it from the shelf.
    apply({ action: "disable", target });
    const again = svc.list("p1").hooks[0]?.shelfId as string;
    const before = readFileSync(projectFile(), "utf8");
    const req: HookChangeRequest = { action: "remove", target: { shelfId: again } };
    expect(svc.diff(req).changed).toBe(false);
    expect(svc.apply(req)).toEqual({ file: null, backupPath: null });
    expect(readFileSync(projectFile(), "utf8")).toBe(before);
    expect(svc.list("p1").hooks).toHaveLength(0);
  });

  it("refuses unparsable files, missing projects and providers without hooks", () => {
    put(userFile(), '{ "hooks": [] }');
    const add = {
      action: "add",
      provider: "claude",
      scope: "user",
      event: "Stop",
      handler: { type: "command", command: "x" },
    };
    expect(errorCode(() => apply(add))).toBe("422 config_unparsable");
    expect(svc.list().sources[0]?.error).toContain("not an object");
    expect(errorCode(() => apply({ ...add, scope: "local" }))).toBe("400 project_required");
    expect(errorCode(() => apply({ ...add, provider: "codex" }))).toBe("400 hooks_unsupported");
  });
});
