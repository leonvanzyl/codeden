import { tmpdir } from "node:os";
import type { ResolvedCommand } from "../util/exec";
import { type OneShotRequest, oneShotSignal, type UtilityModel } from "../utility";
import { modelRef } from "./config";
import { OpenCodeServer } from "./server";

/** Empty string = the model configured in OpenCode. */
export const OPENCODE_UTILITY_MODEL = "";

/**
 * One-shot OpenCode call for the utility model (§7.4): a short-lived private server answers
 * `POST /api/experimental/generate/text`, a plain text generation with no session, no tools and
 * no MCP servers. That endpoint takes no system prompt, so `system` goes in front of the prompt.
 */
export class OpenCodeUtilityModel implements UtilityModel {
  readonly providerId = "opencode";
  readonly defaultModel = OPENCODE_UTILITY_MODEL;

  constructor(private readonly resolveExecutable: () => ResolvedCommand | undefined) {}

  async runOneShot(request: OneShotRequest): Promise<string> {
    const exe = this.resolveExecutable();
    if (!exe) throw new Error("OpenCode is not installed");
    const { signal, dispose } = oneShotSignal(request);
    let server: OpenCodeServer | undefined;
    try {
      server = await OpenCodeServer.start(exe, { cwd: tmpdir(), signal });
      const model = modelRef(request.model ?? OPENCODE_UTILITY_MODEL);
      const prompt = request.system
        ? `${request.system.trim()}\n\n---\n\n${request.prompt}`
        : request.prompt;
      const res = await server.client.post<{ data?: { text?: string } }>(
        "/api/experimental/generate/text",
        { prompt, ...(model ? { model } : {}) },
        signal,
      );
      return (res?.data?.text ?? "").trim();
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
      }
      throw error;
    } finally {
      dispose();
      await server?.close();
    }
  }
}
