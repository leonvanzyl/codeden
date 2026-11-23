import type { ReasoningEffort } from "@codeden/contracts";
import type { SessionConfigChange } from "../adapter";
import { explicitModel } from "../util/model";
import { type OpenCodeClient, OpenCodeHttpError, seg } from "./client";
import { modelId, modelRef, openCodeVariant, SESSION_PERMISSIONS } from "./config";
import type { OcModel, OcModelRef, OcSession } from "./protocol";

/**
 * Opening an OpenCode session (§7.2): the model and effort it runs with, resuming it or creating
 * it in the worktree, archiving it in OpenCode's own list and giving it CodeDen's role prompt.
 */

/** Key of CodeDen's entry in the session's instructions (`<context key="codeden">`). */
const INSTRUCTIONS_KEY = "codeden";

/** The session's model and effort, and a change `configure()` queued for the next turn. */
export class OpenCodeModelChoice {
  /** CodeDen model id; undefined = OpenCode's configured default. */
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private next: SessionConfigChange = {};

  constructor(
    model: string | null | undefined,
    effort: ReasoningEffort | undefined,
    /** Reasoning efforts a model (CodeDen id) offers, from the model list. */
    private readonly modelEfforts?: (
      model: string | undefined,
    ) => readonly ReasoningEffort[] | undefined,
  ) {
    this.model = explicitModel(model);
    this.effort = effort;
  }

  /** Model/effort for the next turn on. */
  queue(change: SessionConfigChange): void {
    this.next = { ...this.next, ...change };
  }

  /** The model reference for the current model and effort (undefined = OpenCode's default). */
  async ref(client: OpenCodeClient): Promise<OcModelRef | undefined> {
    const variant = openCodeVariant(
      this.effort,
      this.modelEfforts?.(this.model ?? (await this.defaultModel(client))),
    );
    const ref = modelRef(this.model, variant);
    if (ref || !variant) return ref;
    // An effort on the default model needs the default's real id.
    const fallback = await this.defaultModel(client);
    return modelRef(fallback, variant);
  }

  async defaultModel(client: OpenCodeClient): Promise<string | undefined> {
    try {
      const res = await client.get<{ data: OcModel | null }>("/api/model/default");
      return res.data ? modelId(res.data) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Take the queued change: the reference the session switches to for good, or undefined when
   * nothing changed (or there is nothing to switch to).
   */
  async takeChange(client: OpenCodeClient): Promise<OcModelRef | undefined> {
    const change = this.next;
    if (change.model === undefined && change.effort === undefined) return undefined;
    this.next = {};
    if (change.model !== undefined) this.model = explicitModel(change.model);
    if (change.effort !== undefined) this.effort = change.effort ?? undefined;
    return (await this.ref(client)) ?? modelRef(await this.defaultModel(client));
  }
}

export interface OpenSessionOptions {
  client: OpenCodeClient;
  /** The OpenCode session to resume, if there is one. */
  resumeId: string | undefined;
  /** Where a new session is created (the worktree). */
  directory: string;
  models: OpenCodeModelChoice;
  /** CodeDen's role prompt. */
  systemPrompt: string | undefined;
  /** Gets the session's id as soon as it is known, before it is archived and instructed. */
  adopt: (id: string) => void;
}

export interface OpenedSession {
  id: string;
  /** CodeDen id of the session's model, when known. */
  model: string | undefined;
  /** Set when the session to resume was gone and a new one was started. */
  notice?: string;
  /** The role prompt, when OpenCode refused it as an instruction: it goes before the next prompt. */
  inlineInstructions?: string;
}

/** Resume the OpenCode session when there is one, else create it. */
export async function openOrResume(opts: OpenSessionOptions): Promise<OpenedSession> {
  const { client, resumeId } = opts;
  const ref = await opts.models.ref(client);
  let session: OcSession | undefined;
  let notice: string | undefined;
  if (resumeId) {
    try {
      session = (await client.get<{ data: OcSession }>(`/api/session/${seg(resumeId)}`)).data;
      await client.patch(`/api/session/${seg(resumeId)}`, { permissions: SESSION_PERMISSIONS });
      if (ref) await client.post(`/api/session/${seg(resumeId)}/model`, { model: ref });
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error;
      session = undefined;
      notice = `Could not resume OpenCode session ${resumeId}; started a new one.`;
    }
  }
  session ??= (
    await client.post<{ data: OcSession }>("/api/session", {
      location: { directory: opts.directory },
      permissions: SESSION_PERMISSIONS,
      ...(ref ? { model: ref } : {}),
    })
  ).data;
  opts.adopt(session.id);
  await archive(client, session.id);
  const instructions = opts.systemPrompt?.trim();
  const refused = instructions ? !(await setInstructions(client, session.id, instructions)) : false;
  const model = ref
    ? modelId(ref)
    : session.model
      ? modelId(session.model)
      : await opts.models.defaultModel(client);
  return {
    id: session.id,
    model,
    ...(notice ? { notice } : {}),
    ...(refused && instructions ? { inlineInstructions: instructions } : {}),
  };
}

/**
 * Archive the session in OpenCode's own session list: CodeDen shows it, so it doesn't clutter
 * the user's OpenCode history. Archived sessions still run prompts. Done on create and on
 * every resume (a no-op once archived), as its own request so an OpenCode that rejects the
 * field never breaks the session.
 */
async function archive(client: OpenCodeClient, id: string): Promise<void> {
  try {
    await client.patch(`/api/session/${seg(id)}`, { archived: true });
  } catch {
    // Best effort: the session works the same unarchived.
  }
}

/** CodeDen's role prompt as a session instruction; false when OpenCode refused it. */
async function setInstructions(client: OpenCodeClient, id: string, text: string): Promise<boolean> {
  try {
    await client.request(
      "PUT",
      `/api/experimental/session/${seg(id)}/instructions/entries/${INSTRUCTIONS_KEY}`,
      { value: text },
    );
    return true;
  } catch {
    return false;
  }
}
