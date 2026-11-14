import type { Project } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/services/exec";
import { createGitBroker, isGitHubHttpsRemote } from "../src/services/git-broker";
import { clonesWorkspaces, type RunnerPort } from "../src/services/runner-port";

/**
 * The git credential broker (`docs/remote-runners.md` §9.2, option A): the GitHub token goes
 * with one git operation, only to a runner that isn't the home runner, and only for https
 * remotes on github.com.
 */

const TOKEN = "gho_brokered";

function port(remote?: { backend?: "local" | "docker" }): RunnerPort {
  return {
    ...(remote ? { remote: () => remote } : {}),
    isConnected: () => true,
    runnerId: () => "r",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: async () => {
      throw new Error("no commands here");
    },
  };
}

const origin =
  (url: string | null): Exec =>
  async () => ({
    code: url ? 0 : 2,
    stdout: url ? `${url}\n` : "",
    stderr: "",
    notFound: false,
    timedOut: false,
    path: null,
  });

const broker = (opts: { token?: string | null; origin?: string | null } = {}) =>
  createGitBroker({
    exec: origin(opts.origin ?? null),
    token: async () => (opts.token === undefined ? TOKEN : opts.token),
  });

const project = (over: Partial<Project> = {}) =>
  ({ id: "p1", kind: "local", path: "/repos/app", ...over }) as Project;

describe("credentialFor", () => {
  const sandbox = port({ backend: "docker" });
  const url = "https://github.com/acme/app.git";

  it("brokers the token to a sandbox runner for an https github.com remote", async () => {
    expect(await broker().credentialFor(sandbox, url)).toEqual({
      scope: "https://github.com",
      username: "x-access-token",
      password: TOKEN,
    });
  });

  it("never brokers to the home runner, or without a GitHub connection", async () => {
    expect(await broker().credentialFor(port(), url)).toBeUndefined();
    expect(await broker({ token: null }).credentialFor(sandbox, url)).toBeUndefined();
    expect(await broker().credentialFor(sandbox, null)).toBeUndefined();
  });

  it.each([
    "http://github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "git://github.com/acme/app.git",
    "file:///repos/app.git",
    "/repos/app.git",
    "https://gitlab.com/acme/app.git",
    "https://github.com.evil.example/acme/app.git",
    "https://evil.example/github.com/acme/app.git",
    "https://someone:pw@github.com/acme/app.git",
    "https://github.com:8443/acme/app.git",
  ])("never brokers for %s", async (remote) => {
    expect(isGitHubHttpsRemote(remote)).toBe(false);
    expect(await broker().credentialFor(sandbox, remote)).toBeUndefined();
  });

  it("brokers a push of a session's clone of a GitHub project only", async () => {
    const github = project({
      kind: "github",
      github: { owner: "acme", repo: "app", remoteUrl: url, defaultBranch: "main" },
    } as Partial<Project>);
    expect(await broker().credentialForProject(sandbox, github)).toMatchObject({ password: TOKEN });
    expect(await broker().credentialForProject(port(), github)).toBeUndefined();
    const local = broker({ origin: "/repos/bare.git" });
    expect(await local.credentialForProject(sandbox, project())).toBeUndefined();
  });
});

describe("cloneUrl", () => {
  it("clones a GitHub project over https, whatever its local remote looks like", async () => {
    const github = project({
      kind: "github",
      github: {
        owner: "acme",
        repo: "app",
        remoteUrl: "git@github.com:acme/app.git",
        defaultBranch: "main",
      },
    } as Partial<Project>);
    expect(await broker().cloneUrl(github)).toBe("https://github.com/acme/app.git");
    expect(await broker({ origin: "git@github.com:acme/app.git" }).cloneUrl(project())).toBe(
      "https://github.com/acme/app.git",
    );
  });

  it("uses another origin as it is, without credentials in it, and none without one", async () => {
    expect(await broker({ origin: "/repos/bare.git" }).cloneUrl(project())).toBe("/repos/bare.git");
    expect(
      await broker({ origin: "https://me:secret@git.example.com/app.git" }).cloneUrl(project()),
    ).toBe("https://git.example.com/app.git");
    expect(await broker({ origin: null }).cloneUrl(project())).toBeNull();
  });
});

describe("clonesWorkspaces", () => {
  it("is true only for a runner that reports a backend other than local", () => {
    expect(clonesWorkspaces(port())).toBe(false);
    expect(clonesWorkspaces(port({}))).toBe(false);
    expect(clonesWorkspaces(port({ backend: "local" }))).toBe(false);
    expect(clonesWorkspaces(port({ backend: "docker" }))).toBe(true);
  });
});
