/** `cross-spawn` ships no types: it is `child_process.spawn` that also runs `.cmd` shims on Windows. */
declare module "cross-spawn" {
  import type { spawn } from "node:child_process";

  const crossSpawn: typeof spawn;
  export default crossSpawn;
}
