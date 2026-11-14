import { parseArgs } from "node:util";
import { CODEDEN_VERSION } from "@codeden/contracts";

export const DEFAULT_PORT = 4317;

export const HELP = `codeden ${CODEDEN_VERSION}: a local-first harness for coding agents

Usage:
  codeden [options]      Start CodeDen and open it in the browser
  codeden doctor         Check the installation (--install: add Claude Code support now)
  codeden update         Install the latest version and switch to it (--rollback: go back)
  codeden stop           Stop the server and the runner
  codeden password       Set the network access password (--generate: make one up)
  codeden network on|off Let phones on your network open CodeDen, or stop it
  codeden runner-link    Connect stdin/stdout to the runner in --home (run by the server
                         inside a sandbox; stdout carries only protocol frames)

Options:
  --port <n>     Port to listen on (default ${DEFAULT_PORT})
  --home <dir>   Data directory (default ~/.codeden, or CODEDEN_HOME)
  --no-open      Do not open the browser
  -v, --version  Print the version
  -h, --help     Show this help
`;

/** The command line; throws on an unknown option. */
export function parseCli(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      home: { type: "string" },
      "no-open": { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      generate: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

export type ParsedCli = ReturnType<typeof parseCli>;
