import { createInterface } from "node:readline";
import {
  type NetworkAddress,
  NetworkStatus,
  PASSWORD_RULE_TEXT,
  passwordProblem,
  SetNetworkPasswordResponse,
} from "@codeden/contracts";
import {
  ensureHome,
  ensureInstallToken,
  FILE_RESET_NOTICES,
  fileResetMessage,
  generatePassphrase,
  listAddresses,
  PasswordRuleError,
  RemoteAccessStore,
} from "@codeden/server";
import { findRunningServer } from "./running";

const DEFAULT_PORT = 4317;

/**
 * The home's network access file, used while CodeDen is not running. A damaged file is kept
 * as a copy and reset (network access off); say so on stderr, as no server is there to.
 */
function openStore(home: string): RemoteAccessStore {
  return new RemoteAccessStore(ensureHome(home).remoteAccess, Date.now, (reset) =>
    console.error(fileResetMessage(reset, FILE_RESET_NOTICES.remoteAccess)),
  );
}

/** Call the running server's network API over loopback with the install token. */
async function callServer(
  home: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: unknown } | undefined> {
  const paths = ensureHome(home);
  const running = await findRunningServer(paths.serverLock);
  if (!running) return undefined;
  const token = ensureInstallToken(paths.token);
  const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

function errorMessage(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : "The server refused the request.";
}

function printAddresses(addresses: NetworkAddress[]): void {
  for (const a of addresses) console.log(`  ${a.label.padEnd(16)} ${a.url}`);
}

/** Ask for a line without echoing it (a TTY), or read the first line of piped input. */
async function readSecret(question: string): Promise<string> {
  const tty = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  if (tty) {
    // Show the question, then hide what is typed.
    process.stdout.write(question);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  }
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      if (tty) process.stdout.write("\n");
      rl.close();
      resolve(line);
    });
    rl.once("close", () => resolve(""));
  });
}

/**
 * `codeden password [--generate]`: set the network-access password (signs out every remote
 * device). Through the running server when there is one, else straight into the home.
 */
export async function passwordCommand(home: string, opts: { generate: boolean }): Promise<number> {
  let password: string | null = null;
  if (!opts.generate) {
    console.log(PASSWORD_RULE_TEXT);
    password = await readSecret("New password: ");
    const problem = passwordProblem(password);
    if (problem) {
      console.error(problem);
      return 1;
    }
    if (process.stdin.isTTY && (await readSecret("Repeat it: ")) !== password) {
      console.error("The two passwords don't match.");
      return 1;
    }
  }

  const viaServer = await callServer(home, "/api/network/password", {
    method: "POST",
    body: password === null ? { generate: true } : { password },
  });
  let generated: string | null;
  if (viaServer) {
    if (!viaServer.ok) {
      console.error(errorMessage(viaServer.body));
      return 1;
    }
    generated = SetNetworkPasswordResponse.parse(viaServer.body).generated;
  } else {
    const store = openStore(home);
    generated = password === null ? generatePassphrase() : null;
    try {
      await store.setPassword(generated ?? (password as string));
    } catch (error) {
      if (error instanceof PasswordRuleError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }
  if (generated) {
    console.log("Your network access password (shown once, keep it somewhere safe):");
    console.log(`  ${generated}`);
  }
  console.log("Password saved. Every remote device was signed out.");
  return 0;
}

/** `codeden network [on|off]`: switch network access, or show its state. */
export async function networkCommand(home: string, action: string | undefined): Promise<number> {
  if (action !== undefined && action !== "on" && action !== "off") {
    console.error("Usage: codeden network [on|off]");
    return 2;
  }
  const viaServer = await callServer(
    home,
    "/api/network",
    action === undefined
      ? { method: "GET" }
      : { method: "PUT", body: { enabled: action === "on" } },
  );
  if (viaServer) {
    if (!viaServer.ok) {
      console.error(errorMessage(viaServer.body));
      if (viaServer.status === 400) console.error("Run: codeden password");
      return 1;
    }
    const status = NetworkStatus.parse(viaServer.body);
    if (status.enabled) {
      console.log("Network access is on. Open CodeDen on your phone at:");
      printAddresses(status.addresses);
    } else {
      console.log("Network access is off: CodeDen only answers on this computer (127.0.0.1).");
    }
    return 0;
  }

  const store = openStore(home);
  if (action === undefined) {
    console.log(
      `Network access is ${store.enabled && store.passwordSet ? "on" : "off"} (CodeDen is not running).`,
    );
    return 0;
  }
  try {
    store.setEnabled(action === "on");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run: codeden password");
    return 1;
  }
  if (action === "on") {
    console.log("Network access is on. When CodeDen starts it will answer on:");
    printAddresses(listAddresses(DEFAULT_PORT));
  } else {
    console.log("Network access is off.");
  }
  return 0;
}
