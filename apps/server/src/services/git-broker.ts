import type { GitCredential, Project } from "@codeden/contracts";
import type { Exec } from "./exec";
import { parseGitHubRemote } from "./projects/detect";
import { isRemoteRunner, type RunnerPort } from "./runner-port";

/**
 * Git for runners that don't share the server's disk (`docs/remote-runners.md` §9): where they
 * clone a project from, and the credential the server brokers for one git operation (§9.2,
 * option A). The home runner gets no credential: it uses the user's own git setup, as before.
 */
export interface GitBroker {
  /** The URL such a runner clones the project from; null when it has no usable `origin`. */
  cloneUrl(project: Project): Promise<string | null>;
  /** The credential for one clone, fetch or push of `remoteUrl` on `runner`, if any. */
  credentialFor(runner: RunnerPort, remoteUrl: string | null): Promise<GitCredential | undefined>;
  /** The credential for a push of a session's clone of `project` (its `origin`), if any. */
  credentialForProject(
    runner: RunnerPort,
    project: Project | null,
  ): Promise<GitCredential | undefined>;
}

export interface GitBrokerDeps {
  exec: Exec;
  /** The user's GitHub token (`GithubAuth`), or null when GitHub isn't connected. */
  token: () => Promise<string | null>;
}

/** The only host the GitHub token is sent for. */
const GITHUB_HOST = "github.com";

/** The https URL of a GitHub repository, which the brokered token works with. */
export function githubCloneUrl(owner: string, repo: string): string {
  return `https://${GITHUB_HOST}/${owner}/${repo}.git`;
}

/** `url` without a user name or password (a token someone put into their remote). */
function withoutUserInfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * True when the token may go with an operation on `remoteUrl`: https to github.com itself, on
 * the default port, with no credentials of its own in the URL.
 */
export function isGitHubHttpsRemote(remoteUrl: string): boolean {
  try {
    const url = new URL(remoteUrl);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === GITHUB_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function createGitBroker(deps: GitBrokerDeps): GitBroker {
  const broker: GitBroker = {
    async cloneUrl(project) {
      // A GitHub project clones over https, so the brokered token works whatever its remote is
      // locally (ssh, scp-style).
      if (project.kind === "github") {
        return githubCloneUrl(project.github.owner, project.github.repo);
      }
      const result = await deps.exec("git", ["-C", project.path, "remote", "get-url", "origin"], {
        timeoutMs: 10_000,
      });
      const origin = result.code === 0 ? result.stdout.trim() : "";
      if (!origin) return null;
      const github = parseGitHubRemote(origin);
      return github ? githubCloneUrl(github.owner, github.repo) : withoutUserInfo(origin);
    },
    async credentialFor(runner, remoteUrl) {
      if (!isRemoteRunner(runner) || !remoteUrl || !isGitHubHttpsRemote(remoteUrl)) {
        return undefined;
      }
      const token = await deps.token();
      const scope = `https://${GITHUB_HOST}`;
      return token ? { scope, username: "x-access-token", password: token } : undefined;
    },
    async credentialForProject(runner, project) {
      if (!isRemoteRunner(runner) || !project) return undefined;
      return broker.credentialFor(runner, await broker.cloneUrl(project));
    },
  };
  return broker;
}
