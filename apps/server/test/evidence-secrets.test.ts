import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shareToChat } from "../src/mcp/tools/share-to-chat";
import type { AppServices } from "../src/services/container";
import { EVIDENCE_BRANCH } from "../src/services/github/evidence";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

// #167: evidence is published to GitHub (public on a public repo, and kept in history), and
// shared files become artifacts evidence can publish by id, so secrets files and CodeDen's own
// credentials never go out, by any name or alias.

let env: GithubEnv;
const P = "p-gh";
const SECRET = "SECRET=hunter2\n";
const refused = { status: 403, code: "secret_file" };

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => env.close());

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

  it("refuses an artifact whose file is a symlink to a secret", async (ctx) => {
    const session = issueSession();
    const artifact = saveArtifact(session.id, "shot.png", Buffer.from([0x89, 0x50]));
    const file = env.artifacts.filePath(artifact);
    writeFileSync(join(dirname(file), ".env"), SECRET);
    unlinkSync(file);
    fileSymlinkOrSkip(join(dirname(file), ".env"), file, () => ctx.skip());
    await expect(
      env.service.attachEvidence(session.id, { files: [{ artifactId: artifact.id }] }),
    ).rejects.toMatchObject(refused);
    nothingPublished();
  });

  it("refuses a symlink to a secret", async (ctx) => {
    writeFileSync(join(env.dir, ".env"), SECRET);
    fileSymlinkOrSkip(join(env.dir, ".env"), join(env.dir, "report.txt"), () => ctx.skip());
    const session = issueSession();
    await expect(
      env.service.attachEvidence(session.id, { files: [{ path: "report.txt" }] }),
    ).rejects.toMatchObject(refused);
    nothingPublished();
  });

  it("still attaches .env.example and screenshots", async () => {
    writeFileSync(join(env.dir, ".env.example"), "SECRET=\n");
    writeFileSync(join(env.dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const session = issueSession();
    const result = await env.service.attachEvidence(session.id, {
      files: [{ path: ".env.example" }, { path: "shot.png" }],
    });
    expect(result.files.map((f) => f.name)).toEqual(["env.example", "shot.png"]);
  });
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
