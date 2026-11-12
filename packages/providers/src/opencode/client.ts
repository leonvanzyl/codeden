import type { OcEvent } from "./protocol";

/** An error response from the OpenCode server (or a request that never got one). */
export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

/**
 * HTTP client for one private `opencode serve` (§7.2). Every request carries Basic auth with
 * the per-process password; the password never appears in errors or logs.
 */
export class OpenCodeClient {
  private readonly auth: string;

  constructor(
    readonly baseUrl: string,
    password: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, body ?? {}, signal);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /** Send a request; resolves with the parsed JSON body (`undefined` for 204). */
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: this.auth,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenCodeHttpError(0, `${method} ${path} failed: ${reason}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const message =
        json &&
        typeof json === "object" &&
        typeof (json as { message?: unknown }).message === "string"
          ? (json as { message: string }).message
          : `HTTP ${res.status}`;
      throw new OpenCodeHttpError(res.status, `${method} ${path}: ${message}`, json);
    }
    return json as T;
  }

  /**
   * Subscribe to `GET /api/event` and call `onEvent` for every event until `signal` aborts or
   * the stream ends. Resolves once the subscription is open (the server sends
   * `server.connected` first), so nothing that happens afterwards is missed. `onEnd` runs
   * when the stream closes for any reason other than the abort.
   */
  async subscribe(
    onEvent: (event: OcEvent) => void,
    signal: AbortSignal,
    onEnd: (error?: Error) => void = () => {},
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/event`, {
      headers: { authorization: this.auth, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpenCodeHttpError(res.status, `GET /api/event: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const parser = new SseParser((data) => {
      try {
        onEvent(JSON.parse(data) as OcEvent);
      } catch {
        // A malformed event is skipped; the next one may still be fine.
      }
    });
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        if (!signal.aborted) onEnd();
      } catch (error) {
        if (!signal.aborted) onEnd(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }
}

/** Incremental Server-Sent Events parser: calls `onData` with each event's joined `data:`. */
export class SseParser {
  private buffer = "";

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    for (let end = this.buffer.indexOf("\n\n"); end >= 0; end = this.buffer.indexOf("\n\n")) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n");
      if (data) this.onData(data);
    }
  }
}

/** URL-encode one path segment (ids are opaque). */
export const seg = (value: string): string => encodeURIComponent(value);
