import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunnerStream } from "@codeden/contracts";

/** The page the browser tests drive: absolute-positioned controls at known coordinates. */
export const TEST_PAGE = `<!doctype html>
<html><head><title>CodeDen browser test</title>
<style>
  body { margin: 0; font: 16px system-ui, sans-serif; background: #f6f3ee; }
  #big { position: absolute; left: 100px; top: 100px; width: 200px; height: 100px; font-size: 20px; }
  #name { position: absolute; left: 100px; top: 300px; width: 200px; height: 30px; }
  #greet { position: absolute; left: 340px; top: 300px; height: 36px; }
  #out { position: absolute; left: 100px; top: 360px; font-size: 24px; }
</style></head>
<body>
  <button id="big" onclick="this.textContent='clicked by human'">Press me</button>
  <input id="name" aria-label="Name">
  <button id="greet" onclick="document.getElementById('out').textContent='Hello ' + document.getElementById('name').value">Greet</button>
  <p id="out"></p>
  <script>console.log('page ready'); fetch('/api/ping');</script>
</body></html>`;

/** Buttons that open a confirm, a prompt and an alert, and write what they returned to `#out`. */
export const DIALOGS_PAGE = `<!doctype html>
<html><head><title>Dialogs</title>
<style>
  body { margin: 0; font: 16px system-ui, sans-serif; }
  button { position: absolute; left: 100px; width: 200px; height: 40px; }
  #del { top: 100px; } #ren { top: 160px; } #note { top: 220px; }
  #out { position: absolute; left: 100px; top: 300px; }
</style></head>
<body>
  <button id="del" onclick="out.textContent = confirm('Delete this item?') ? 'deleted' : 'kept'">Delete</button>
  <button id="ren" onclick="out.textContent = 'name: ' + prompt('New name?', 'draft')">Rename</button>
  <button id="note" onclick="alert('Saved!'); out.textContent = 'alert closed'">Notify</button>
  <p id="out"></p>
</body></html>`;

/** Local HTTP server for browser tests (pages, cookies, a slow-appearing element). */
export class TestSite {
  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly port: number,
  ) {}

  static async start(): Promise<TestSite> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("content-type", "text/html; charset=utf-8");
      switch (url.pathname) {
        case "/":
          return res.end(TEST_PAGE);
        case "/api/ping":
          res.setHeader("content-type", "application/json");
          return res.end('{"ok":true}');
        case "/set":
          res.setHeader("set-cookie", `who=${url.searchParams.get("v") ?? ""}; Path=/`);
          return res.end("<title>set</title>cookie set");
        case "/whoami":
          return res.end(
            "<title>whoami</title><p id=c></p><script>c.textContent = document.cookie || 'none'</script>",
          );
        case "/later":
          return res.end(
            "<title>later</title><script>setTimeout(() => { const p = document.createElement('p'); p.textContent = 'arrived late'; document.body.append(p); }, 300)</script>",
          );
        case "/page2":
          return res.end("<title>Second page</title><h1>Second</h1>");
        case "/dialogs":
          return res.end(DIALOGS_PAGE);
        default:
          res.statusCode = 404;
          return res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return new TestSite(server, `http://127.0.0.1:${port}`, port);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

/** Collects stream messages emitted by a BrowserManager. */
export class StreamRecorder {
  readonly items: RunnerStream[] = [];
  readonly push = (data: RunnerStream) => {
    this.items.push(data);
  };

  frames(sessionId: string) {
    return this.items.filter(
      (i): i is Extract<RunnerStream, { kind: "browser.frame" }> =>
        i.kind === "browser.frame" && i.sessionId === sessionId,
    );
  }
}
