import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentSkillListResponse,
  LoadedAgentConfig,
  SkillSwitchRequest,
  SlashCommandList,
} from "@codeden/contracts";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import { notFound, ServiceError } from "../src/services/errors";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionRepo } from "../src/services/sessions/repo";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill\n---\nSteps\n`;

describe("skill switches", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let backups: string;
  let session: { provider: string; cwd: string; projectId: string | null };
  let service: AgentConfigService;
  const userSettings = () => join(home, ".claude", "settings.json");
  const projectSettings = () => join(repo, ".claude", "settings.json");
  const localSettings = () => join(repo, ".claude", "settings.local.json");
  const codexConfig = () => join(home, ".codex", "config.toml");

  const list = (projectId?: string) =>
    AgentSkillListResponse.parse({ skills: service.skills.list(projectId) }).skills;
  const find = (name: string, provider = "claude", projectId?: string) => {
    const skill = list(projectId).find((s) => s.name === name && s.provider === provider);
    if (!skill) throw new Error(`no ${provider} skill ${name}`);
    return skill;
  };
  /** A switch request for a listed skill, as the Skills tab sends it. */
  const request = (name: string, enabled: boolean, provider = "claude", listProjectId?: string) => {
    const { root, projectId, path } = find(name, provider, listProjectId).file;
    return SkillSwitchRequest.parse({
      root,
      projectId,
      path,
      provider,
      enabled,
      ...(listProjectId ? { listProjectId } : {}),
    });
  };
  const errorCode = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof ServiceError ? `${error.status} ${error.code}` : String(error);
    }
    return "no error";
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-skills-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    backups = join(dir, "backups");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    session = { provider: "claude", cwd: repo, projectId: "p1" };
    service = new AgentConfigService({
      home,
      projects: {
        get: (id: string) => {
          if (id !== "p1") throw notFound(`No project ${id}`, "project_not_found");
          return { id, path: repo };
        },
      } as unknown as ProjectService,
      repo: { get: () => session } as unknown as SessionRepo,
      backupDir: backups,
      disabledHooksFile: join(dir, "disabled-hooks.json"),
      mcpProxyUrl: () => null,
      runner: { request: () => Promise.reject(new Error("no runner")) },
      reportedCommands: () => null,
    });
    put(join(home, ".claude", "skills", "deploy", "SKILL.md"), skillMd("deploy"));
    put(join(repo, ".claude", "skills", "lint", "SKILL.md"), skillMd("lint"));
    put(join(home, ".codex", "skills", "review", "SKILL.md"), skillMd("review"));
    put(join(repo, ".agents", "skills", "release", "SKILL.md"), skillMd("release"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("Claude Code skillOverrides", () => {
    it("reads each skill's state, the most specific file winning", () => {
      put(userSettings(), JSON.stringify({ skillOverrides: { deploy: "off", lint: "off" } }));
      put(projectSettings(), JSON.stringify({ skillOverrides: { lint: "name-only" } }));
      put(localSettings(), JSON.stringify({ skillOverrides: { deploy: "on", other: "bogus" } }));

      expect(find("deploy", "claude", "p1")).toMatchObject({
        enabled: true,
        setIn: localSettings(),
      });
      const lint = find("lint", "claude", "p1");
      expect(lint).toMatchObject({
        enabled: true,
        visibility: "name-only",
        setIn: projectSettings(),
      });
      // Without a project only the user's file applies.
      expect(find("deploy")).toMatchObject({ enabled: false, setIn: userSettings() });
      // A skill no file names is on.
      expect(find("review", "codex")).toMatchObject({ enabled: true, setIn: null });
    });

    it("switches a skill off in the user's settings, changing only skillOverrides", () => {
      const original =
        '{\n    "model": "opus",\n    "permissions": {\n        "allow": [ "Bash(ls)" ]\n    }\n}\n';
      put(userSettings(), original);
      const req = request("lint", false, "claude", "p1");

      const diff = service.skills.diff(req);
      expect(diff).toMatchObject({ absolutePath: userSettings(), scope: "user", changed: true });
      expect(diff.patch).toContain('+    "skillOverrides": {');
      expect(readFileSync(userSettings(), "utf8")).toBe(original);

      const res = service.skills.apply(req);
      expect(res.file).toBe(userSettings());
      expect(res.backupPath && readFileSync(res.backupPath, "utf8")).toBe(original);
      const after = readFileSync(userSettings(), "utf8");
      expect(after.startsWith(original.slice(0, original.lastIndexOf("\n}")))).toBe(true);
      expect(JSON.parse(after)).toEqual({
        ...JSON.parse(original),
        skillOverrides: { lint: "off" },
      });
      expect(res.skills.find((s) => s.name === "lint")).toMatchObject({
        enabled: false,
        setIn: userSettings(),
      });
      // The project's files were not touched.
      expect(existsSync(projectSettings()) || existsSync(localSettings())).toBe(false);
    });

    it("creates a missing settings file, and a no-op switch writes nothing", () => {
      expect(service.skills.apply(request("deploy", true))).toMatchObject({
        file: null,
        backupPath: null,
      });
      expect(existsSync(userSettings())).toBe(false);
      const res = service.skills.apply(request("deploy", false));
      expect(res).toMatchObject({ file: userSettings(), backupPath: null });
      expect(JSON.parse(readFileSync(userSettings(), "utf8"))).toEqual({
        skillOverrides: { deploy: "off" },
      });
    });

    it("switches a skill on in the file that turns it off", () => {
      put(projectSettings(), JSON.stringify({ skillOverrides: { lint: "off", keep: "off" } }));
      service.skills.apply(request("lint", true, "claude", "p1"));
      expect(JSON.parse(readFileSync(projectSettings(), "utf8")).skillOverrides).toEqual({
        keep: "off",
      });
      expect(find("lint", "claude", "p1")).toMatchObject({ enabled: true, setIn: null });
      expect(existsSync(userSettings())).toBe(false);
    });

    it('writes "on" when a lower file would still turn the skill off', () => {
      put(userSettings(), JSON.stringify({ skillOverrides: { deploy: "off" } }));
      put(localSettings(), JSON.stringify({ skillOverrides: { deploy: "off" } }));
      const diff = service.skills.diff(request("deploy", true, "claude", "p1"));
      expect(diff).toMatchObject({ absolutePath: localSettings(), scope: "local" });
      service.skills.apply(request("deploy", true, "claude", "p1"));
      expect(JSON.parse(readFileSync(localSettings(), "utf8")).skillOverrides).toEqual({
        deploy: "on",
      });
      expect(JSON.parse(readFileSync(userSettings(), "utf8")).skillOverrides).toEqual({
        deploy: "off",
      });
      expect(find("deploy", "claude", "p1").enabled).toBe(true);
    });

    it("ignores a skillOverrides that isn't an object, in a file that still applies", () => {
      for (const ignored of [null, [], false, "off"]) {
        const user = `${JSON.stringify({ model: "opus", skillOverrides: ignored }, null, 2)}\n`;
        put(userSettings(), user);
        put(localSettings(), JSON.stringify({ skillOverrides: { deploy: "off" } }));
        expect(find("deploy", "claude", "p1")).toMatchObject({
          enabled: false,
          setIn: localSettings(),
        });

        // On edits the local file that decides it; the user's file isn't touched.
        const res = service.skills.apply(request("deploy", true, "claude", "p1"));
        expect(res.file).toBe(localSettings());
        expect(JSON.parse(readFileSync(localSettings(), "utf8")).skillOverrides).toEqual({});
        expect(readFileSync(userSettings(), "utf8")).toBe(user);
        expect(find("deploy", "claude", "p1")).toMatchObject({ enabled: true, setIn: null });

        // Off, with nothing deciding it, writes the user's file, replacing the ignored value.
        service.skills.apply(request("deploy", false, "claude", "p1"));
        expect(JSON.parse(readFileSync(userSettings(), "utf8"))).toEqual({
          model: "opus",
          skillOverrides: { deploy: "off" },
        });
      }
    });

    it("keeps skill names that look like object keys as plain entries", () => {
      put(join(home, ".claude", "skills", "ctor", "SKILL.md"), skillMd("constructor"));
      expect(find("constructor")).toMatchObject({ enabled: true, setIn: null });
      service.skills.apply(request("constructor", false));
      expect(JSON.parse(readFileSync(userSettings(), "utf8")).skillOverrides).toEqual({
        constructor: "off",
      });
      expect(find("constructor").enabled).toBe(false);
    });
  });

  describe("Codex [[skills.config]]", () => {
    const original = [
      "# My Codex settings",
      'model = "gpt-5" # keep this comment',
      "",
      "[mcp_servers.docs]",
      'command = "npx"',
      "",
      "[skills]",
      "include_instructions = true",
      "",
    ].join("\n");

    it("applies rules in order, by path or by name, the last one winning", () => {
      const reviewPath = join(home, ".codex", "skills", "review", "SKILL.md");
      put(
        codexConfig(),
        [
          "[[skills.config]]",
          `path = ${JSON.stringify(reviewPath.toUpperCase())}`,
          "enabled = false",
          "",
          "[[skills.config]]",
          'name = "release"',
          "enabled = false",
          "",
        ].join("\n"),
      );
      const review = find("review", "codex");
      // Paths compare case-insensitively where the file system does.
      expect(review.enabled).toBe(process.platform === "linux");
      expect(find("release", "codex", "p1")).toMatchObject({
        enabled: false,
        setIn: codexConfig(),
      });

      put(
        codexConfig(),
        `${readFileSync(codexConfig(), "utf8")}\n[[skills.config]]\nname = "release"\nenabled = true\n`,
      );
      expect(find("release", "codex", "p1")).toMatchObject({ enabled: true, setIn: codexConfig() });
    });

    it("switches a user skill off by path and back on, keeping the rest of the file", () => {
      put(codexConfig(), original);
      const req = request("review", false, "codex");
      const diff = service.skills.diff(req);
      expect(diff).toMatchObject({ absolutePath: codexConfig(), scope: "user", changed: true });
      expect(readFileSync(codexConfig(), "utf8")).toBe(original);

      const res = service.skills.apply(req);
      expect(res.backupPath && readFileSync(res.backupPath, "utf8")).toBe(original);
      const after = readFileSync(codexConfig(), "utf8");
      expect(after.startsWith(original)).toBe(true);
      const skillPath = find("review", "codex").file.absolutePath;
      expect(parseToml(after)).toMatchObject({
        model: "gpt-5",
        mcp_servers: { docs: { command: "npx" } },
        skills: { include_instructions: true, config: [{ path: skillPath, enabled: false }] },
      });
      expect(find("review", "codex")).toMatchObject({ enabled: false, setIn: codexConfig() });

      service.skills.apply(request("review", true, "codex"));
      expect(readFileSync(codexConfig(), "utf8").trimEnd()).toBe(original.trimEnd());
      expect(find("review", "codex")).toMatchObject({ enabled: true, setIn: null });
    });

    it("switches a project skill off by name, and on again drops every entry for it", () => {
      put(codexConfig(), `${original}\n[[skills.config]]\nname = "other"\nenabled = false\n`);
      service.skills.apply(request("release", false, "codex", "p1"));
      const doc = parseToml(readFileSync(codexConfig(), "utf8")) as {
        skills: { config: unknown[] };
      };
      expect(doc.skills.config).toEqual([
        { name: "other", enabled: false },
        { name: "release", enabled: false },
      ]);
      expect(find("release", "codex", "p1").enabled).toBe(false);

      service.skills.apply(request("release", true, "codex", "p1"));
      const back = parseToml(readFileSync(codexConfig(), "utf8")) as {
        skills: { config: unknown[]; include_instructions: boolean };
      };
      expect(back.skills).toEqual({
        include_instructions: true,
        config: [{ name: "other", enabled: false }],
      });
      expect(readFileSync(codexConfig(), "utf8")).toContain("# My Codex settings");
    });

    it("creates config.toml when it is missing", () => {
      service.skills.apply(request("release", false, "codex", "p1"));
      expect(readFileSync(codexConfig(), "utf8")).toBe(
        '[[skills.config]]\nname = "release"\nenabled = false\n',
      );
    });

    it("keeps the file's comments when it removes the only rule", () => {
      put(codexConfig(), '# top\n[[skills.config]]\nname = "review"\nenabled = false\n# tail\n');
      expect(find("review", "codex").enabled).toBe(false);
      service.skills.apply(request("review", true, "codex"));
      expect(readFileSync(codexConfig(), "utf8")).toBe("# top\n# tail\n");
      expect(find("review", "codex")).toMatchObject({ enabled: true, setIn: null });
    });

    it("keeps comments at the end of the lines it removes, on lines of their own", () => {
      put(
        codexConfig(),
        '[[skills.config]] # skill defaults\nname = "review"\n  enabled = false # review rationale\n',
      );
      service.skills.apply(request("review", true, "codex"));
      expect(readFileSync(codexConfig(), "utf8")).toBe("# skill defaults\n  # review rationale\n");

      // A `#` inside a string is not a comment, and other rules' comments stay where they are.
      const start = [
        "[mcp_servers.docs]",
        'command = "npx#1" # the docs tool',
        "",
        "[[skills.config]]",
        'name = "x#y" # not ours',
        "enabled = false",
        "",
        "[[skills.config]]",
        'name = "release" # off: too noisy',
        "enabled = false",
        "",
      ].join("\n");
      put(codexConfig(), start);
      service.skills.apply(request("release", true, "codex", "p1"));
      expect(readFileSync(codexConfig(), "utf8")).toBe(
        [
          "[mcp_servers.docs]",
          'command = "npx#1" # the docs tool',
          "",
          "[[skills.config]]",
          'name = "x#y" # not ours',
          "enabled = false",
          "",
          "# off: too noisy",
          "",
        ].join("\n"),
      );
      expect(parseToml(readFileSync(codexConfig(), "utf8"))).toMatchObject({
        mcp_servers: { docs: { command: "npx#1" } },
        skills: { config: [{ name: "x#y", enabled: false }] },
      });
    });

    it("refuses to remove an inline rule when its line's comment would go with it", () => {
      const inline =
        'skills = { config = [{ name = "release", enabled = false }] } # global settings note\n';
      put(codexConfig(), inline);
      expect(errorCode(() => service.skills.apply(request("release", true, "codex", "p1")))).toBe(
        "422 config_edit_unsafe",
      );
      expect(readFileSync(codexConfig(), "utf8")).toBe(inline);
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    });

    it("keeps header, rule and footer comments when it removes one of several rules", () => {
      const lines = (...l: string[]) => l.join("\r\n");
      const start = lines(
        "# Codex settings",
        'model = "gpt-5"',
        "",
        "[skills]",
        "include_instructions = true",
        "",
        "# Rules",
        "[[skills.config]]",
        "# release is noisy",
        'name = "release"',
        "enabled = false",
        "",
        "[[skills.config]]",
        'name = "other"',
        "enabled = false",
        "",
        "[mcp_servers.docs]",
        'command = "npx" # inline',
        "# footer",
        "",
      );
      put(codexConfig(), start);
      service.skills.apply(request("release", true, "codex", "p1"));
      const withoutRelease = lines(
        "# Codex settings",
        'model = "gpt-5"',
        "",
        "[skills]",
        "include_instructions = true",
        "",
        "# Rules",
        "# release is noisy",
        "",
        "[[skills.config]]",
        'name = "other"',
        "enabled = false",
        "",
        "[mcp_servers.docs]",
        'command = "npx" # inline',
        "# footer",
        "",
      );
      expect(readFileSync(codexConfig(), "utf8")).toBe(withoutRelease);

      // A new rule goes after the last remaining one, and removing it restores the file.
      service.skills.apply(request("review", false, "codex"));
      const added = readFileSync(codexConfig(), "utf8");
      const reviewPath = find("review", "codex").file.absolutePath;
      expect(added).toBe(
        withoutRelease.replace(
          "enabled = false\r\n\r\n[mcp_servers",
          `enabled = false\r\n\r\n[[skills.config]]\r\npath = ${JSON.stringify(reviewPath)}\r\nenabled = false\r\n\r\n[mcp_servers`,
        ),
      );
      expect(parseToml(added)).toMatchObject({
        skills: {
          include_instructions: true,
          config: [
            { name: "other", enabled: false },
            { path: reviewPath, enabled: false },
          ],
        },
        mcp_servers: { docs: { command: "npx" } },
      });
      service.skills.apply(request("review", true, "codex"));
      expect(readFileSync(codexConfig(), "utf8")).toBe(withoutRelease);
    });

    it("patches rules written inline only when every comment survives", () => {
      // Rules written as an inline array can't be edited as blocks; the structural patch is
      // used only when it keeps every comment, and the switch is refused otherwise.
      const inline = '[skills]\n# why\nconfig = [ { name = "release", enabled = false } ]\n';
      put(codexConfig(), inline);
      expect(errorCode(() => service.skills.apply(request("release", true, "codex", "p1")))).toBe(
        "422 config_edit_unsafe",
      );
      expect(readFileSync(codexConfig(), "utf8")).toBe(inline);
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);

      service.skills.apply(request("review", false, "codex"));
      const after = readFileSync(codexConfig(), "utf8");
      expect(after).toContain("# why");
      expect(find("review", "codex").enabled).toBe(false);
      expect(find("release", "codex", "p1").enabled).toBe(false);
    });
  });

  describe("refusals", () => {
    it("answers 404 for a skill that isn't listed, and 422 for an unparsable file", () => {
      const lint = request("lint", false, "claude", "p1");
      // Listed for the project, not without it.
      expect(errorCode(() => service.skills.diff({ ...lint, listProjectId: undefined }))).toBe(
        "404 skill_not_found",
      );
      expect(errorCode(() => service.skills.diff({ ...lint, provider: "codex" }))).toBe(
        "404 skill_not_found",
      );
      put(userSettings(), "{ not json");
      expect(errorCode(() => service.skills.apply(lint))).toBe("422 config_unparsable");
      expect(readFileSync(userSettings(), "utf8")).toBe("{ not json");
      put(codexConfig(), "skills = 3\n");
      expect(errorCode(() => service.skills.diff(request("review", false, "codex")))).toBe(
        "422 config_unparsable",
      );
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    });

    it("refuses a switch while a project or local settings file doesn't parse", () => {
      const backupsMade = () => (existsSync(backups) ? readdirSync(backups) : []);
      for (const broken of [projectSettings(), localSettings()]) {
        rmSync(join(repo, ".claude", "settings.json"), { force: true });
        rmSync(join(repo, ".claude", "settings.local.json"), { force: true });
        put(broken, "{ not json");
        for (const enabled of [false, true]) {
          const req = request("deploy", enabled, "claude", "p1");
          expect(errorCode(() => service.skills.diff(req))).toBe("422 config_unparsable");
          expect(errorCode(() => service.skills.apply(req))).toBe("422 config_unparsable");
        }
        // Nothing was written anywhere, the user's file included, and nothing was backed up.
        expect(existsSync(userSettings())).toBe(false);
        expect(readFileSync(broken, "utf8")).toBe("{ not json");
        expect(backupsMade()).toEqual([]);
        // Listing stays tolerant: the file just sets nothing.
        expect(find("deploy", "claude", "p1")).toMatchObject({ enabled: true, setIn: null });
      }
    });

    it("refuses a switch while a project's settings lead outside it through a link", () => {
      const outside = join(dir, "outside-project");
      put(
        join(outside, "settings.local.json"),
        JSON.stringify({ skillOverrides: { deploy: "off" } }),
      );
      put(join(outside, "skills", "lint", "SKILL.md"), skillMd("lint"));
      rmSync(join(repo, ".claude"), { recursive: true, force: true });
      symlinkSync(outside, join(repo, ".claude"), "junction");
      put(userSettings(), '{ "model": "opus" }\n');
      for (const enabled of [false, true]) {
        const req = request("deploy", enabled, "claude", "p1");
        expect(errorCode(() => service.skills.diff(req))).toBe("403 path_outside_root");
        expect(errorCode(() => service.skills.apply(req))).toBe("403 path_outside_root");
      }
      expect(readFileSync(userSettings(), "utf8")).toBe('{ "model": "opus" }\n');
      expect(readFileSync(join(outside, "settings.local.json"), "utf8")).toContain('"off"');
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
      // The linked file isn't read for the list either.
      expect(find("deploy", "claude", "p1")).toMatchObject({ enabled: true, setIn: null });
    });

    it("doesn't read a Codex config.toml that leads outside home", () => {
      const outside = join(dir, "outside-codex");
      put(join(outside, "config.toml"), '[[skills.config]]\nname = "review"\nenabled = false\n');
      put(join(outside, "skills", "review", "SKILL.md"), skillMd("review"));
      rmSync(join(home, ".codex"), { recursive: true, force: true });
      symlinkSync(outside, join(home, ".codex"), "junction");
      expect(find("review", "codex")).toMatchObject({ enabled: true, setIn: null });
      expect(errorCode(() => service.skills.diff(request("review", false, "codex")))).toBe(
        "403 path_outside_root",
      );
    });

    it("refuses a settings file that leads outside its folder through a link", () => {
      const outside = join(dir, "outside");
      mkdirSync(outside, { recursive: true });
      put(join(outside, "settings.json"), JSON.stringify({ skillOverrides: { lint: "off" } }));
      // The user's `.claude` folder links outside home (a junction needs no rights on Windows).
      rmSync(join(home, ".claude"), { recursive: true, force: true });
      mkdirSync(join(outside, "skills", "deploy"), { recursive: true });
      writeFileSync(join(outside, "skills", "deploy", "SKILL.md"), skillMd("deploy"));
      symlinkSync(outside, join(home, ".claude"), "junction");
      expect(errorCode(() => service.skills.diff(request("lint", false, "claude", "p1")))).toBe(
        "403 path_outside_root",
      );
      // The file outside isn't read either.
      expect(find("lint", "claude", "p1")).toMatchObject({ enabled: true, setIn: null });
    });
  });

  describe("sessions", () => {
    it("marks switched-off skills in What's loaded and leaves them out of the / menu", () => {
      put(localSettings(), JSON.stringify({ skillOverrides: { lint: "off" } }));
      put(userSettings(), JSON.stringify({ skillOverrides: { deploy: "user-invocable-only" } }));
      const loaded = LoadedAgentConfig.parse(service.loaded("s1"));
      expect(loaded.skills.map((s) => [s.name, s.enabled, s.visibility])).toEqual([
        ["deploy", true, "user-invocable-only"],
        ["lint", false, undefined],
      ]);
      const names = SlashCommandList.parse(service.slashCommands("s1")).map((c) => c.name);
      expect(names).toEqual(["deploy"]);

      session = { provider: "codex", cwd: repo, projectId: "p1" };
      put(codexConfig(), '[[skills.config]]\nname = "release"\nenabled = false\n');
      const codex = LoadedAgentConfig.parse(service.loaded("s1"));
      expect(codex.skills.map((s) => [s.name, s.enabled])).toEqual([
        ["review", true],
        ["release", false],
      ]);
      expect(SlashCommandList.parse(service.slashCommands("s1")).map((c) => c.name)).toEqual([
        "review",
      ]);
    });
  });
});
