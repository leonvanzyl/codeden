import type { Usage } from "@codeden/contracts";
import type { OcTokens } from "./protocol";

/**
 * Token and cost accounting for one turn. OpenCode reports each model call (`step.ended`,
 * `step.failed`, compactions) with its own tokens and USD cost, so a turn's usage is their sum,
 * subagent steps included. OpenCode's `output` excludes reasoning; CodeDen's `outputTokens`
 * includes it. `input` already excludes cache reads and writes, as CodeDen's does.
 */
export class TurnUsage {
  private input = 0;
  private output = 0;
  private reasoning = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private context: number | undefined;

  constructor(private readonly contextWindow?: number) {}

  /** Fold one model call in. `root` calls (not subagents) set the context occupancy. */
  add(tokens: OcTokens | undefined, costUsd: number | undefined, root = true): void {
    if (tokens) {
      const input = tokenCount(tokens.input);
      const output = tokenCount(tokens.output);
      const reasoning = tokenCount(tokens.reasoning);
      const read = tokenCount(tokens.cache?.read);
      const write = tokenCount(tokens.cache?.write);
      this.input += input;
      this.output += output;
      this.reasoning += reasoning;
      this.cacheRead += read;
      this.cacheWrite += write;
      if (root) this.context = input + read + write + output + reasoning;
    }
    this.cost += nonNegative(costUsd);
  }

  /**
   * The turn's usage so far. Cost is left out when OpenCode reported none (free models, or
   * providers without prices), so the usage ledger can price the model itself.
   */
  snapshot(): Usage {
    return {
      inputTokens: this.input,
      outputTokens: this.output + this.reasoning,
      cachedInputTokens: this.cacheRead,
      cacheWriteTokens: this.cacheWrite,
      reasoningTokens: this.reasoning,
      ...(this.context !== undefined ? { contextTokens: this.context } : {}),
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
      ...(this.cost > 0 ? { costUsd: round(this.cost) } : {}),
    };
  }
}

const nonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const tokenCount = (value: number | undefined): number => Math.round(nonNegative(value));

const round = (usd: number): number => Math.round(usd * 1e8) / 1e8;
