import type { SubagentModelUsage } from "@codeden/contracts";
import { count, str } from "../util/text";

type Raw = Record<string, unknown>;

/** The billed token counts of one API call. */
interface CallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface Call extends CallTokens {
  model?: string;
}

/** Token counts of one call from a Messages API `usage` object; undefined when it has none. */
export function callTokens(usage: unknown): CallTokens | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Raw;
  const details = u.output_tokens_details as Raw | null | undefined;
  const tokens = {
    input: count(u.input_tokens) ?? 0,
    output: count(u.output_tokens) ?? 0,
    cacheRead: count(u.cache_read_input_tokens) ?? 0,
    cacheWrite: count(u.cache_creation_input_tokens) ?? 0,
    reasoning: count(details?.thinking_tokens) ?? 0,
  };
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0
    ? tokens
    : undefined;
}

/**
 * Tokens per model across one subagent's own API calls, for its card's cost (§7.3). Claude
 * streams a call as several `assistant` frames sharing its message id (one per content block),
 * each with the call's usage as it stood when the call started: input and cache counts are
 * final, output is not. So calls are keyed by message id, frames of one call merge (the larger
 * figure wins), and the subagent's transcript, read once it has finished, supplies the final
 * figures (`applyTranscript`).
 */
export class SubagentUsage {
  private readonly calls = new Map<string, Call>();

  /** Fold in one streamed frame (`message` of an `assistant` message). */
  addFrame(message: Raw): void {
    const id = str(message, "id");
    const tokens = callTokens(message.usage);
    if (!id || !tokens) return;
    const model = modelOf(message);
    const prev = this.calls.get(id);
    this.calls.set(id, {
      ...(model || prev?.model ? { model: model ?? prev?.model } : {}),
      input: Math.max(tokens.input, prev?.input ?? 0),
      output: Math.max(tokens.output, prev?.output ?? 0),
      cacheRead: Math.max(tokens.cacheRead, prev?.cacheRead ?? 0),
      cacheWrite: Math.max(tokens.cacheWrite, prev?.cacheWrite ?? 0),
      reasoning: Math.max(tokens.reasoning, prev?.reasoning ?? 0),
    });
  }

  /**
   * Take the final figures of the calls the frames showed from the subagent's transcript
   * (`getSubagentMessages`): per message id, the transcript wins. Calls only the transcript
   * holds are left out (an earlier run of a resumed subagent); calls it doesn't hold yet keep
   * their streamed figures. Returns whether anything changed.
   */
  applyTranscript(messages: readonly unknown[]): boolean {
    let changed = false;
    for (const entry of messages) {
      const raw = str(entry, "type") === "assistant" ? (entry as Raw).message : undefined;
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Raw;
      const id = str(message, "id");
      const prev = id ? this.calls.get(id) : undefined;
      const tokens = callTokens(message.usage);
      if (!id || !prev || !tokens) continue;
      const model = modelOf(message) ?? prev.model;
      const next: Call = { ...(model ? { model } : {}), ...tokens };
      if (!sameCall(prev, next)) {
        this.calls.set(id, next);
        changed = true;
      }
    }
    return changed;
  }

  /** Tokens per model in the order the models were first used; undefined with no calls. */
  summary(): SubagentModelUsage[] | undefined {
    const byModel = new Map<string, Call>();
    for (const call of this.calls.values()) {
      const key = call.model ?? "";
      const sum = byModel.get(key);
      byModel.set(key, {
        ...(call.model ? { model: call.model } : {}),
        input: (sum?.input ?? 0) + call.input,
        output: (sum?.output ?? 0) + call.output,
        cacheRead: (sum?.cacheRead ?? 0) + call.cacheRead,
        cacheWrite: (sum?.cacheWrite ?? 0) + call.cacheWrite,
        reasoning: (sum?.reasoning ?? 0) + call.reasoning,
      });
    }
    if (byModel.size === 0) return undefined;
    return [...byModel.values()].map((c) => ({
      ...(c.model ? { model: c.model } : {}),
      inputTokens: c.input,
      outputTokens: c.output,
      cacheReadTokens: c.cacheRead,
      cacheWriteTokens: c.cacheWrite,
      ...(c.reasoning > 0 ? { reasoningTokens: c.reasoning } : {}),
    }));
  }
}

/** The model that served a call; Claude Code marks its own placeholder replies `<synthetic>`. */
function modelOf(message: Raw): string | undefined {
  const model = str(message, "model")?.trim();
  return model && model !== "<synthetic>" ? model : undefined;
}

function sameCall(a: Call, b: Call): boolean {
  return (
    a.model === b.model &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.reasoning === b.reasoning
  );
}
