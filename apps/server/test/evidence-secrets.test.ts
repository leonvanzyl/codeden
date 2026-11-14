import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CODEDEN_CREDENTIAL_FILES, INVALID_COPY_SUFFIX } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareToChat } from "../src/mcp/tools/share-to-chat";
import { RemoteAccessStore } from "../src/network/store";
import type { AppServices } from "../src/services/container";
import { EVIDENCE_BRANCH } from "../src/services/github/evidence";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

// #167: evidence is published to GitHub (public on a public repo, and kept in history), and
// shared files become artifacts evidence can publish by id, so secrets files and CodeDen's own
// credentials never go out, by any name or alias.

/**
 * File symlinks need a privilege on Windows (Developer Mode), so tests also model one without
 * it: a `link` is an ordinary file whose real path (`realPathOf`) is its `target`, which is
 * what the evidence and share checks see of a real file symlink.
 */
const links = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/services/files/path-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/files/path-guard")>();
  return {
    ...actual,
    realPathOf: (path: string) => actual.realPathOf(links.get(resolve(path)) ?? path),
  };
});

let env: GithubEnv;
const P = "p-gh";
const SECRET = "SECRET=hunter2\n";
const refused = { status: 403, code: "secret_file" };
/** Refused as a secret, or before that because its real file is outside the artifacts folder. */
const refusedOrOutside = {
  status: 403,
  code: expect.stringMatching(/^(secret_file|path_outside_root)$/),
};

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => {
  links.clear();
  env.close();
});

/** A stand-in file symlink at `path` to `target`, which needs no privilege (see `links`). */
function stubFileSymlink(target: string, path: string) {
  writeFileSync(path, "a harmless decoy\n");
  links.set(resolve(path), target);
}

/** A session linked to issue #1, the default evidence target. */
function issueSession() {
  env.gh.addIssue();
  return env.addSession({ issue: { number: 1, url: "https://github.com/acme/widgets/issues/1" } });
}

function nothingPublished() {
  expect(env.gh.gitData.refs.get(`refs/heads/${EVIDENCE_BRANCH}`)).toBeUndefined();
  expect(env.gh.issues.get(1)?.comments ?? []).toHaveLength(0);
}

function saveArtifact(sessionId: string, name: string, bytes = Buffer.from(SECRET)) {
  return env.artifacts.save({
    bytes,
    name,
    mediaType: name.endsWith(".png") ? "image/png" : "text/plain",
    kind: "file",
    projectId: P,
    sessionId,
  });
}

/** `share_to_chat`'s handler, with the services it reads before storing anything. */
function share(sessionId: string, input: { path: string; name?: string }) {
  const services = {
    sessionRepo: env.repo,
    artifacts: env.artifacts,
    paths: { home: env.dir },
  } as unknown as AppServices;
  return shareToChat.handler(input, { services, sessionId } as never);
}

/** A file symlink, or skip: Windows without Developer Mode can't create one. */
function fileSymlinkOrSkip(target: string, path: string, skip: () => void) {
  try {
    symlinkSync(target, path, "file");
  } catch {
    skip();
  }
}

/** Each symlink test runs with a real file symlink where allowed, and always with a stand-in. */
const LINKS: Array<[string, (target: string, path: string, skip: () => void) => void]> = [
  ["a real file symlink", fileSymlinkOrSkip],
  ["a stand-in file symlink", (target, path) => stubFileSymlink(target, path)],
];

describe("attach_evidence refuses secrets", () => {
  it.each([
    [".env in the worktree", (dir: string, _temp: string) => [dir, ".env"]],
    [".env.local in the worktree", (dir: string) => [dir, ".env.local"]],
    ["an SSH key copied into temp", (_dir: string, temp: string) => [temp, "id_rsa"]],
    ["a .pem in temp", (_dir: string, temp: string) => [temp, "server.pem"]],
    [".npmrc in temp", (_dir: string, temp: string) => [temp, ".npmrc"]],
    ["CodeDen's install token", (dir: string) => [dir, "install-token"]],
    ["the runner lock", (dir: string) => [dir, "runner", "runner.json"]],
  ])("refuses to publish %s", async (_label, where) => {
    const temp = mkdtempSync(join(tmpdir(), "codeden-evidence-"));
    try {
      const file = join(...where(env.dir, temp));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, SECRET);
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: file }] }),
      ).rejects.toMatchObject(refused);
      nothingPublished();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses a secret under a harmless name, and a harmless file under a secret's name", async () => {
    writeFileSync(join(env.dir, ".env"), SECRET);
    writeFileSync(join(env.dir, "notes.txt"), "notes\n");
    const session = issueSession();
    const attach = (file: { path: string; name: string }) =>
      env.service.attachEvidence(session.id, { files: [file] });
    await expect(attach({ path: ".env", name: "config.txt" })).rejects.toMatchObject(refused);
    await expect(attach({ path: "notes.txt", name: ".env" })).rejects.toMatchObject(refused);
    nothingPublished();
  });

  it("refuses an artifact saved under a secret's name, by id and by its file path", async () => {
    const session = issueSession();
    const artifact = saveArtifact(session.id, ".env");
    await expect(
      env.service.attachEvidence(session.id, {
        files: [{ artifactId: artifact.id, name: "log.txt" }],
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      env.service.attachEvidence(session.id, {
        files: [{ path: env.artifacts.filePath(artifact), name: "report.txt" }],
      }),
    ).rejects.toMatchObject(refused);
    nothingPublished();
  });

  it("checks the real file of an artifact attached by id, not its path through a junction", async () => {
    const session = issueSession();
    // The session's artifacts folder is a junction into a `.ssh` folder.
    const ssh = join(env.dir, "artifacts", ".ssh");
    mkdirSync(ssh);
    symlinkSync(ssh, env.artifacts.sessionDir(session.id), "junction");
    const artifact = saveArtifact(session.id, "report.txt");
    await expect(
      env.service.attachEvidence(session.id, {
        files: [{ artifactId: artifact.id, name: "report.txt" }],
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      env.service.attachEvidence(session.id, {
        files: [{ path: env.artifacts.filePath(artifact) }],
      }),
    ).rejects.toMatchObject(refused);
    nothingPublished();
  });

  for (const [kind, link] of LINKS) {
    it(`refuses an artifact whose file is ${kind} to a secret`, async (ctx) => {
      const session = issueSession();
      const artifact = saveArtifact(session.id, "shot.png", Buffer.from([0x89, 0x50]));
      const file = env.artifacts.filePath(artifact);
      writeFileSync(join(dirname(file), ".env"), SECRET);
      unlinkSync(file);
      link(join(dirname(file), ".env"), file, () => ctx.skip());
      await expect(
        env.service.attachEvidence(session.id, { files: [{ artifactId: artifact.id }] }),
      ).rejects.toMatchObject(refused);
      nothingPublished();
    });

    it(`refuses ${kind} to a secret`, async (ctx) => {
      writeFileSync(join(env.dir, ".env"), SECRET);
      link(join(env.dir, ".env"), join(env.dir, "report.txt"), () => ctx.skip());
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: "report.txt" }] }),
      ).rejects.toMatchObject(refused);
      nothingPublished();
    });
  }

  // #283: the agent CLIs' own logins, in a temp folder standing in for the user's home.
  describe.each([
    ["Codex's login", [".codex", "auth.json"]],
    ["Claude's credentials", [".claude", ".credentials.json"]],
    ["Claude's global config", [".claude.json"]],
    ["Gemini CLI's OAuth file", [".gemini", "oauth_creds.json"]],
    ["Gemini CLI's accounts", [".gemini", "google_accounts.json"]],
    ["OpenCode's login", [".local", "share", "opencode", "auth.json"]],
    ["gh's hosts.yml", [".config", "gh", "hosts.yml"]],
  ])("%s in the user's home", (_label, parts) => {
    let home: string;
    let file: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "codeden-home-"));
      file = join(home, ...parts);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"refresh_token":"hunter2"}\n');
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("attach_evidence refuses it, under any published name", async () => {
      const session = issueSession();
      for (const files of [[{ path: file }], [{ path: file, name: "notes.txt" }]]) {
        await expect(env.service.attachEvidence(session.id, { files })).rejects.toMatchObject(
          refused,
        );
      }
      nothingPublished();
    });

    it("share_to_chat refuses it, under any name", async () => {
      const session = issueSession();
      for (const input of [{ path: file }, { path: file, name: "shot.png" }]) {
        await expect(share(session.id, input)).rejects.toMatchObject(refused);
      }
      expect(env.artifacts.list({ sessionId: session.id })).toEqual([]);
    });
  });

  it("refuses a login in a home the user moved (CODEX_HOME), but not that home's settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "codeden-codex-home-"));
    vi.stubEnv("CODEX_HOME", home);
    try {
      writeFileSync(join(home, "auth.json"), '{"refresh_token":"hunter2"}\n');
      writeFileSync(join(home, "config.toml"), 'model = "x"\n');
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: join(home, "auth.json") }] }),
      ).rejects.toMatchObject(refused);
      await expect(share(session.id, { path: join(home, "auth.json") })).rejects.toMatchObject(
        refused,
      );
      nothingPublished();
      const result = await env.service.attachEvidence(session.id, {
        files: [{ path: join(home, "config.toml") }],
      });
      expect(result.files.map((f) => f.name)).toEqual(["config.toml"]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still attaches .env.example, screenshots and oddly named ordinary files", async () => {
    writeFileSync(join(env.dir, ".env.example"), "SECRET=\n");
    writeFileSync(join(env.dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(env.dir, "-results (1).log"), "ok\n");
    const session = issueSession();
    const result = await env.service.attachEvidence(session.id, {
      files: [{ path: ".env.example" }, { path: "shot.png" }, { path: "-results (1).log" }],
    });
    expect(result.files.map((f) => f.name)).toEqual(["env.example", "shot.png", "results-1.log"]);
  });
});

describe("copies CodeDen keeps of a damaged credential file", () => {
  // #170: a malformed remote-access.json is kept as `remote-access.json.invalid-<timestamp>`,
  // with the password and session-token hashes still in it.
  function remoteAccessBackup(): string {
    const file = join(env.dir, "remote-access.json");
    writeFileSync(file, '{"enabled":true,"password":{"hash":"scrypt$secret-hash"');
    let copy: string | undefined;
    new RemoteAccessStore(
      file,
      () => 1_700_000_000_000,
      (reset) => {
        copy = reset.copy;
      },
    );
    expect(copy).toBe(`${file}${INVALID_COPY_SUFFIX}1700000000000`);
    expect(readFileSync(copy as string, "utf8")).toContain("secret-hash");
    return copy as string;
  }

  function nothingStored(sessionId: string) {
    expect(env.artifacts.list({ sessionId })).toEqual([]);
    nothingPublished();
  }

  it("attach_evidence refuses the remote-access backup, under any published name", async () => {
    const copy = remoteAccessBackup();
    const session = issueSession();
    for (const file of [{ path: copy }, { path: copy, name: "notes.txt" }]) {
      await expect(env.service.attachEvidence(session.id, { files: [file] })).rejects.toMatchObject(
        refused,
      );
    }
    nothingStored(session.id);
  });

  it("share_to_chat refuses the remote-access backup, under any name", async () => {
    const copy = remoteAccessBackup();
    const session = issueSession();
    for (const input of [{ path: copy }, { path: copy, name: "shot.png" }]) {
      await expect(share(session.id, input)).rejects.toMatchObject(refused);
    }
    nothingStored(session.id);
  });

  for (const [kind, link] of LINKS) {
    it(`refuses the backup through ${kind} with a harmless name`, async (ctx) => {
      const copy = remoteAccessBackup();
      link(copy, join(env.dir, "report.txt"), () => ctx.skip());
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: "report.txt" }] }),
      ).rejects.toMatchObject(refused);
      await expect(share(session.id, { path: "report.txt" })).rejects.toMatchObject(refused);
      nothingStored(session.id);
    });

    it(`refuses an artifact whose file is ${kind} to the backup, attached by id`, async (ctx) => {
      const copy = remoteAccessBackup();
      const session = issueSession();
      const artifact = saveArtifact(session.id, "shot.png", Buffer.from([0x89, 0x50]));
      const file = env.artifacts.filePath(artifact);
      unlinkSync(file);
      link(copy, file, () => ctx.skip());
      // The backup sits next to remote-access.json, outside the artifacts folder, so a real link
      // to it may be refused by the artifacts folder's own check first (`path_outside_root`). The
      // stand-in passes that check, so it must be the secrets check that refuses it.
      await expect(
        env.service.attachEvidence(session.id, {
          files: [{ artifactId: artifact.id, name: "shot.png" }],
        }),
      ).rejects.toMatchObject(link === fileSymlinkOrSkip ? refusedOrOutside : refused);
      nothingPublished();
    });
  }

  it("refuses the backup reached through a junction to the data folder", async () => {
    const copy = remoteAccessBackup();
    // A directory junction needs no privilege on Windows (a directory symlink elsewhere).
    const temp = mkdtempSync(join(tmpdir(), "codeden-alias-"));
    try {
      const alias = join(temp, "data");
      symlinkSync(env.dir, alias, "junction");
      const aliased = join(alias, basename(copy));
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: aliased, name: "notes.txt" }] }),
      ).rejects.toMatchObject(refused);
      await expect(share(session.id, { path: aliased, name: "notes.txt" })).rejects.toMatchObject(
        refused,
      );
      nothingStored(session.id);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(CODEDEN_CREDENTIAL_FILES)("refuses a copy of %s", async (name) => {
    const copy = join(env.dir, `${name}${INVALID_COPY_SUFFIX}42`);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, SECRET);
    const session = issueSession();
    await expect(
      env.service.attachEvidence(session.id, { files: [{ path: copy, name: "log.txt" }] }),
    ).rejects.toMatchObject(refused);
    await expect(share(session.id, { path: copy, name: "log.txt" })).rejects.toMatchObject(refused);
    nothingStored(session.id);
  });
});

// #186: published names keep only `[A-Za-z0-9._-]` and drop leading dashes and dots, so these
// would go out as notes.pem, id_rsa and credentials.json.
describe("names that sanitise into a secret's name", () => {
  const NAMES = ["notes.p!em", "-id_rsa", "credentials.js!on"];

  it.each(NAMES)(
    "attach_evidence refuses %s, by path, as the name to publish under and by id",
    async (name) => {
      writeFileSync(join(env.dir, name), SECRET);
      writeFileSync(join(env.dir, "notes.txt"), "notes\n");
      const session = issueSession();
      const legacy = saveArtifact(session.id, name);
      const attach = (file: { path?: string; artifactId?: string; name?: string }) =>
        env.service.attachEvidence(session.id, { files: [file] });
      await expect(attach({ path: name })).rejects.toMatchObject(refused);
      await expect(attach({ path: "notes.txt", name })).rejects.toMatchObject(refused);
      await expect(attach({ artifactId: legacy.id })).rejects.toMatchObject(refused);
      nothingPublished();
    },
  );

  it.each(NAMES)("share_to_chat won't stage %s for attach by id", async (name) => {
    writeFileSync(join(env.dir, name), SECRET);
    writeFileSync(join(env.dir, "notes.txt"), "notes\n");
    const session = issueSession();
    const outcomes = [
      await share(session.id, { path: name }).catch((error: unknown) => error),
      await share(session.id, { path: "notes.txt", name }).catch((error: unknown) => error),
    ];
    // Nothing is stored that attach_evidence would publish by id under the sanitised name.
    expect(env.artifacts.list({ sessionId: session.id }).map((a) => a.name)).toEqual([]);
    for (const outcome of outcomes) expect(outcome).toMatchObject(refused);
  });

  // A separator becomes `-` too: these would go out as service-account.json.
  it.each(["service/account.json", "service\\account.json"])(
    "refuses %s as the name to publish or share under, and as an artifact's name",
    async (name) => {
      writeFileSync(join(env.dir, "notes.txt"), "notes\n");
      const session = issueSession();
      await expect(
        env.service.attachEvidence(session.id, { files: [{ path: "notes.txt", name }] }),
      ).rejects.toMatchObject({
        ...refused,
        message: expect.stringContaining(`${name} (published as service-account.json)`),
      });
      const shared = await share(session.id, { path: "notes.txt", name }).catch(
        (error: unknown) => error,
      );
      expect(env.artifacts.list({ sessionId: session.id }).map((a) => a.name)).toEqual([]);
      expect(shared).toMatchObject(refused);
      const legacy = saveArtifact(session.id, name);
      await expect(
        env.service.attachEvidence(session.id, { files: [{ artifactId: legacy.id }] }),
      ).rejects.toMatchObject(refused);
      nothingPublished();
    },
  );

  it("checks the final names, after `-2` tells repeated names apart", async () => {
    writeFileSync(join(env.dir, "process.env"), "notes\n");
    const session = issueSession();
    // `process.env` is code, not a secrets file, but a second one would go out as process-2.env.
    // Its real path is checked by file name only, so the file itself still attaches.
    const file = { path: "process.env" };
    await expect(
      env.service.attachEvidence(session.id, { files: [file, file] }),
    ).rejects.toMatchObject(refused);
    nothingPublished();
    const once = await env.service.attachEvidence(session.id, { files: [file] });
    expect(once.files.map((f) => f.name)).toEqual(["process.env"]);
  });
});

// #186: a file symlink to a legacy `.env` artifact's stored file (`<id>.txt`) must still be
// known by the artifact's original name, with the artifacts folder plain or aliased.
describe.each([
  ["a plain artifacts folder", false],
  ["an aliased artifacts folder", true],
])("a secret artifact reached through a file symlink, with %s", (_label, aliasArtifacts) => {
  beforeEach(() => {
    env.close();
    env = createGithubEnv({ aliasArtifacts });
  });

  for (const [kind, link] of LINKS) {
    it(`attach_evidence refuses it through ${kind}, by path`, async (ctx) => {
      const session = issueSession();
      const legacy = saveArtifact(session.id, ".env");
      link(env.artifacts.filePath(legacy), join(env.dir, "report.txt"), () => ctx.skip());
      const attach = (file: { path: string; name?: string }) =>
        env.service.attachEvidence(session.id, { files: [file] });
      await expect(attach({ path: "report.txt" })).rejects.toMatchObject(refused);
      await expect(attach({ path: "report.txt", name: "log.txt" })).rejects.toMatchObject(refused);
      nothingPublished();
    });

    it(`share_to_chat won't stage it through ${kind} for attach by id`, async (ctx) => {
      const session = issueSession();
      const legacy = saveArtifact(session.id, ".env");
      link(env.artifacts.filePath(legacy), join(env.dir, "report.txt"), () => ctx.skip());
      await expect(share(session.id, { path: "report.txt" })).rejects.toMatchObject(refused);
      await expect(
        share(session.id, { path: "report.txt", name: "report.txt" }),
      ).rejects.toMatchObject(refused);
      expect(env.artifacts.list({ sessionId: session.id }).map((a) => a.id)).toEqual([legacy.id]);
      nothingPublished();
    });
  }
});

describe("when the artifacts folder is an alias (a junction to another folder)", () => {
  beforeEach(() => {
    env.close();
    env = createGithubEnv({ aliasArtifacts: true });
  });

  it("still knows an artifact's original name when its file is attached by path", async () => {
    const session = issueSession();
    const legacy = saveArtifact(session.id, ".env");
    const file = env.artifacts.filePath(legacy);
    await expect(
      env.service.attachEvidence(session.id, { files: [{ path: file, name: "report.txt" }] }),
    ).rejects.toMatchObject(refused);
    await expect(
      env.service.attachEvidence(session.id, { files: [{ artifactId: legacy.id }] }),
    ).rejects.toMatchObject(refused);
    nothingPublished();

    // Ordinary artifacts still attach, by id and by path.
    const shot = saveArtifact(session.id, "shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await env.service.attachEvidence(session.id, {
      files: [{ artifactId: shot.id }, { path: env.artifacts.filePath(shot), name: "again.png" }],
    });
    expect(result.files.map((f) => f.name)).toEqual(["shot.png", "again.png"]);
  });

  it("share_to_chat won't stage a secret artifact under a harmless name for attach by id", async () => {
    const session = issueSession();
    const legacy = saveArtifact(session.id, ".env");
    await expect(
      share(session.id, { path: env.artifacts.filePath(legacy), name: "report.txt" }),
    ).rejects.toMatchObject(refused);
    expect(env.artifacts.list({ sessionId: session.id }).map((a) => a.id)).toEqual([legacy.id]);
    nothingPublished();
  });
});
