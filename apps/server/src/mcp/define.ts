import type { Role, ToolContext, ToolScope } from "@codeden/contracts";
import type { z } from "zod";
import type { AppServices } from "../services/container";

/** What a tool handler gets: the caller (from its token) plus the application services. */
export type ServerToolContext<S extends ToolScope = ToolScope> = ToolContext<S> & {
  services: AppServices;
};

/**
 * A CodeDen tool (§8.3): one registry, exposed to agents over MCP and callable by API
 * handlers, so agents and the UI share the same services and can never drift apart.
 */
export interface ServerTool<TInput extends z.ZodType = z.ZodType, S extends ToolScope = ToolScope> {
  /** snake_case, unique across the registry. */
  name: string;
  /** Shown to agents; written for a model. */
  description: string;
  /** Roles that see and may call the tool; it is not listed for anyone else. */
  roles: readonly Role[];
  /** What the handler is bound to, resolved from the caller's token. */
  scope: S;
  input: TInput;
  /** Core tools load upfront; the rest may be deferred behind the agent's tool search. */
  alwaysLoad?: boolean;
  /**
   * Hidden when false (e.g. a tool whose engine is not configured, or GitHub tools in a
   * local-only project). `caller` is the token's project and session when known.
   */
  isAvailable?: (services: AppServices, caller?: ToolAvailabilityContext) => boolean;
  /**
   * Descriptions of top-level input parameters that depend on the server's state when the tools
   * are listed (e.g. which providers are loaded and ready), keyed by parameter name. They replace
   * the schema's own description in the listing only; validation doesn't change.
   */
  describeInput?: (
    services: AppServices,
    caller?: ToolAvailabilityContext,
  ) => Promise<Record<string, string>>;
  /** Returns text (or a JSON-serialisable value) for the agent. */
  handler: (input: z.output<TInput>, ctx: ServerToolContext<S>) => Promise<unknown>;
}

/** Who a tool list is for, so tools can hide themselves per project. */
export interface ToolAvailabilityContext {
  projectId: string | null;
  sessionId: string | null;
}

/** Identity helper that infers a tool's input and scope types. */
export function defineTool<TInput extends z.ZodType, S extends ToolScope>(
  tool: ServerTool<TInput, S>,
): ServerTool<TInput, S> {
  return tool;
}

/** Any tool, for registries. */
// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous tools.
export type AnyServerTool = ServerTool<any, ToolScope>;

/** An image returned to the agent next to the text (MCP `image` content). */
export interface ToolImage {
  /** Base64 data. */
  data: string;
  mediaType: string;
}

/** A handler result with images, e.g. a browser screenshot the agent should see. */
export class ToolOutput {
  constructor(
    readonly text: string,
    readonly images: ToolImage[] = [],
  ) {}
}

/** A tool failure reported to the agent as an MCP error result (not a protocol error). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
