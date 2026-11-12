/**
 * The subset of OpenCode's v2 HTTP API (`opencode serve`, routes under `/api`) that CodeDen
 * uses, written from the server's `/openapi.json` (OpenCode 2.2.7). Fields CodeDen does not
 * read are left out; everything the server may omit is optional.
 */

/** `providerID` + model `id`, plus an optional `variant` (OpenCode's reasoning effort). */
export interface OcModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Token counts. `input` excludes cache reads and writes; `output` excludes `reasoning`. */
export interface OcTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcError {
  type: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

/**
 * `GET /api/model` entry. Costs are USD per million tokens: the base price, and entries with a
 * `tier` for prices that apply above a context size.
 */
export interface OcModel {
  id: string;
  providerID: string;
  name?: string;
  family?: string;
  status?: string;
  enabled?: boolean;
  variants?: { id: string }[];
  cost?: {
    tier?: { type: string; size: number };
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  }[];
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[] };
}

/** `GET /api/provider` entry: a provider OpenCode can use (credentials, env or config). */
export interface OcProvider {
  id: string;
  name?: string;
  integrationID?: string;
  activation?: string;
}

/** `GET /api/credential` entry (secrets are never returned by the list). */
export interface OcCredential {
  id: string;
  integrationID: string;
  label?: string;
  active?: boolean;
}

/** One ordered permission rule; the last matching rule wins. */
export interface OcPermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface OcSession {
  id: string;
  parentID?: string;
  title?: string;
  model?: OcModelRef;
  cost?: number;
  tokens?: OcTokens;
  permissions?: OcPermissionRule[];
  location?: { directory: string };
}

/** A file change in permission or tool metadata (`metadata.files`). */
export interface OcFileDiff {
  file: string;
  patch?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

/** `permission.asked`: a tool call waiting for `POST /permission/:id/reply`. */
export interface OcPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: string; messageID: string; id: string };
  message?: string;
}

export interface OcFormOption {
  value: string;
  label: string;
  description?: string;
}

export interface OcFormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: OcFormOption[];
  custom?: boolean;
  url?: string;
}

/** `form.created`: the `question` tool and other structured input requests. */
export interface OcForm {
  id: string;
  sessionID: string;
  title: string;
  metadata?: { kind?: string; tool?: { messageID: string; id: string } } & Record<string, unknown>;
  fields: OcFormField[];
}

export type OcFormValue = string | number | boolean | string[];

/** Tool result content. */
export type OcToolContent =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

type SessionScoped<T> = { sessionID: string } & T;
type StepScoped<T> = SessionScoped<{ assistantMessageID: string } & T>;

/** The events CodeDen reads from `GET /api/event` (SSE). Others are ignored. */
export type OcEvent =
  | { type: "server.connected"; data?: unknown }
  | {
      type: "session.created";
      data: SessionScoped<{ parentID?: string; title?: string; agent?: string }>;
    }
  | { type: "session.execution.started"; data: SessionScoped<object> }
  | { type: "session.execution.succeeded"; data: SessionScoped<object> }
  | { type: "session.execution.failed"; data: SessionScoped<{ error: OcError }> }
  | { type: "session.execution.interrupted"; data: SessionScoped<{ reason: string }> }
  | { type: "session.step.started"; data: StepScoped<{ model?: OcModelRef; agent?: string }> }
  | {
      type: "session.step.ended";
      data: StepScoped<{ finish?: string; cost?: number; tokens?: OcTokens; files?: string[] }>;
    }
  | {
      type: "session.step.failed";
      data: StepScoped<{ error: OcError; cost?: number; tokens?: OcTokens }>;
    }
  | { type: "session.text.started"; data: StepScoped<{ ordinal: number }> }
  | { type: "session.text.delta"; data: StepScoped<{ ordinal: number; delta: string }> }
  | { type: "session.text.ended"; data: StepScoped<{ ordinal: number; text: string }> }
  | { type: "session.reasoning.started"; data: StepScoped<{ ordinal: number }> }
  | { type: "session.reasoning.delta"; data: StepScoped<{ ordinal: number; delta: string }> }
  | { type: "session.reasoning.ended"; data: StepScoped<{ ordinal: number; text: string }> }
  | { type: "session.tool.input.started"; data: StepScoped<{ id: string; name: string }> }
  | { type: "session.tool.input.delta"; data: StepScoped<{ id: string; delta: string }> }
  | {
      type: "session.tool.called";
      data: StepScoped<{ id: string; input: Record<string, unknown> }>;
    }
  | {
      type: "session.tool.progress";
      data: StepScoped<{ id: string; metadata: Record<string, unknown> }>;
    }
  | {
      type: "session.tool.success";
      data: StepScoped<{
        id: string;
        content?: OcToolContent[];
        metadata?: Record<string, unknown>;
      }>;
    }
  | {
      type: "session.tool.failed";
      data: StepScoped<{
        id: string;
        error: OcError;
        content?: OcToolContent[];
        metadata?: Record<string, unknown>;
      }>;
    }
  | {
      type: "session.retry.scheduled";
      data: StepScoped<{ attempt: number; at?: number; error: OcError }>;
    }
  | { type: "session.compaction.started"; data: SessionScoped<{ reason: string }> }
  | {
      type: "session.compaction.ended";
      data: SessionScoped<{ reason: string; cost?: number; tokens?: OcTokens }>;
    }
  | {
      type: "session.compaction.failed";
      data: SessionScoped<{ error: OcError; cost?: number; tokens?: OcTokens }>;
    }
  | { type: "session.model.selected"; data: SessionScoped<{ model: OcModelRef }> }
  | { type: "shell.created"; data: { info: { id: string; command?: string; cwd?: string } } }
  | { type: "shell.exited"; data: { id: string; exit?: number | null } }
  | { type: "permission.asked"; data: OcPermissionRequest }
  | { type: "permission.replied"; data: SessionScoped<{ requestID: string; reply: string }> }
  | { type: "form.created"; data: { form: OcForm } }
  | { type: "form.replied"; data: { id: string; sessionID: string } }
  | { type: "form.cancelled"; data: { id: string; sessionID: string } };

export type OcEventType = OcEvent["type"];
export type OcEventOf<T extends OcEventType> = Extract<OcEvent, { type: T }>;
