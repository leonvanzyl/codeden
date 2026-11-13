import type { SessionOptions } from "@codeden/contracts";

/**
 * Options an agent session is opened with (§4.2): the server's, with `CI=true` in its
 * environment. An agent's shell has no terminal, so a command that asks a question waits
 * forever, such as pnpm's "The modules directory will be removed and reinstalled from scratch.
 * Proceed?". `CI=true` is what pnpm, and most other tools, read to never ask. A `CI` the user's
 * own environment (`base`) sets is kept, so `CI=false` opts out, and a value the server passes in
 * `SessionOptions.env` wins over both. Every provider applies `SessionOptions.env` to the agent
 * process, so this holds for all of them.
 *
 * A project can turn this off (`SessionOptions.ciEnv: false`, from `Project.agentCiEnv`) when
 * `CI=true` gets in its tools' way: the options are then passed on unchanged, with no `CI` added.
 */
export function agentSessionOptions(
  opts: SessionOptions,
  base: NodeJS.ProcessEnv = process.env,
): SessionOptions {
  if (opts.ciEnv === false) return opts;
  return { ...opts, env: { CI: base.CI || "true", ...opts.env } };
}
