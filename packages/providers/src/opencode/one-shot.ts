import { tmpdir } from "node:os";
import type { ResolvedCommand } from "../util/exec";
import { explicitModel } from "../util/model";
import { type OneShotRequest, oneShotSignal, type UtilityModel } from "../utility";
import type { OpenCodeClient } from "./client";
import { modelRef } from "./config";
import { cheapUtilityModel } from "./models";
import type { OcModel, OcModelRef } from "./protocol";
import { OpenCodeServer } from "./server";

/** Empty string = no model chosen in Settings: a cheap one is picked (`cheapUtilityModel`). */
export const OPENCODE_UTILITY_MODEL = "";

/**
 * One-shot OpenCode call for the utility model (§7.4): a short-lived private server answers
 * `POST /api/experimental/generate/text`, a plain text generation with no session, no tools and
 * no MCP servers. That endpoint takes no system prompt, so `system` goes in front of the prompt.
 * With no model chosen in Settings, the cheapest model from the default model's provider is
 * used, read from the same server's model lists (no model call).
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
      const model = explicitModel(request.model)
        ? modelRef(request.model)
        : await cheapModel(server.client, signal);
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

/** The cheap utility model, or undefined (OpenCode's default) when the lists can't be read. */
async function cheapModel(
  client: OpenCodeClient,
  signal: AbortSignal,
): Promise<OcModelRef | undefined> {
  try {
    const [byDefault, list] = await Promise.all([
      client.get<{ data?: OcModel | null }>("/api/model/default", signal),
      client.get<{ data?: OcModel[] }>("/api/model", signal),
    ]);
    return cheapUtilityModel(list?.data ?? [], byDefault?.data);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}
