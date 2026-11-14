import type { ProviderCapabilities, ProviderInfo, ReasoningEffort } from "@codeden/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildStartRequest,
  type DraftChoice,
  type DraftDefaults,
  emptyChoice,
  localConflict,
  pickModel,
  resolveDraftChoice,
} from "@/lib/new-session";
import { newSessionDraftKey, persistedDrafts } from "@/stores/composer";
import { useNewSessionStore } from "@/stores/new-session";

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: true,
  images: true,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: true,
  ...over,
});

const planner: ProviderInfo = {
  id: "planner",
  displayName: "Planner",
  capabilities: caps({ planMode: true, reasoningEffort: true }),
  models: [
    { id: "small", label: "Small", efforts: [] },
    { id: "big", label: "Big", efforts: ["low", "high"], isDefault: true },
  ],
};
const plain: ProviderInfo = {
  id: "plain",
  displayName: "Plain",
  capabilities: caps(),
  models: [{ id: "only", label: "Only", efforts: [] }],
};

type ProjectDefaults = NonNullable<DraftDefaults["project"]>;
const noProjectDefaults: ProjectDefaults = {
  defaultProvider: null,
  defaultModel: null,
  defaultEffort: null,
  autonomy: null,
};
const projectWith = (over: Partial<ProjectDefaults>): ProjectDefaults => ({
  ...noProjectDefaults,
  ...over,
});
const agentOn = (
  provider: string,
  model: string | null = null,
  effort: ReasoningEffort | null = null,
) => ({
  provider,
  model,
  effort,
});

const defaults = (over: Partial<DraftDefaults> = {}): DraftDefaults => ({
  providers: [planner, plain],
  project: noProjectDefaults,
  agent: agentOn("auto"),
  defaultAutonomy: "auto",
  ...over,
});
const choice = (over: Partial<DraftChoice> = {}): DraftChoice => ({ ...emptyChoice, ...over });

describe("resolveDraftChoice (the New session draft's defaults)", () => {
  it("picks the provider: chosen, then project default, then agent default, then the first", () => {
    const id = (c: DraftChoice, d: DraftDefaults) => resolveDraftChoice(c, d).provider?.id;
    expect(id(choice(), defaults())).toBe("planner");
    expect(id(choice(), defaults({ agent: agentOn("plain") }))).toBe("plain");
    const projectPlain = projectWith({ defaultProvider: "plain" });
    expect(id(choice(), defaults({ project: projectPlain, agent: agentOn("planner") }))).toBe(
      "plain",
    );
    expect(
      id(
        choice({ provider: "planner" }),
        defaults({ project: projectPlain, agent: agentOn("plain") }),
      ),
    ).toBe("planner");
    // A provider the runner doesn't list (gone, or a stale saved choice) is skipped.
    const gone = projectWith({ defaultProvider: "gone" });
    expect(id(choice({ provider: "gone" }), defaults({ project: gone }))).toBe("planner");
    expect(resolveDraftChoice(choice(), defaults({ providers: [] })).provider).toBeUndefined();
    // Settings or the project not loaded yet.
    expect(id(choice(), defaults({ project: undefined, agent: null }))).toBe("planner");
  });

  it("uses the model picked for that provider, else its default model, else its first", () => {
    const model = (c: DraftChoice, d = defaults()) => resolveDraftChoice(c, d).model;
    expect(model(choice())).toBe("big");
    expect(model(choice({ provider: "plain" }))).toBe("only");
    expect(model(choice({ provider: "planner", model: "small" }))).toBe("small");
    // A custom model id typed into the picker is sent as it is.
    expect(model(choice({ provider: "planner", model: "big-preview" }))).toBe("big-preview");
    // A model picked for a provider that is gone doesn't carry over to the fallback.
    expect(model(choice({ provider: "gone", model: "x" }))).toBe("big");
  });

  it("starts from the Settings agent default model and effort on that provider (#261)", () => {
    // Settings > Providers > Agent sessions: Planner, Small, high effort.
    const settingsAgent = defaults({ agent: agentOn("planner", "small", "high") });
    const resolved = resolveDraftChoice(choice(), settingsAgent);
    expect(resolved.provider?.id).toBe("planner");
    expect(resolved).toMatchObject({ model: "small", effort: "high" });
    // The first send carries them, so the session starts on what Settings says.
    expect(buildStartRequest("p1", { text: "Go" }, resolved, "")).toMatchObject({
      provider: "planner",
      model: "small",
      effort: "high",
    });
  });

  it("takes model and effort from the project, then Settings, then the provider (#261)", () => {
    const pick = (d: DraftDefaults, c = choice()) => {
      const { provider, model, effort } = resolveDraftChoice(c, d);
      return { provider: provider?.id, model, effort };
    };
    const settingsSmall = agentOn("planner", "small", "high");
    // The project's default agent wins over Settings.
    const projectBig = projectWith({
      defaultProvider: "planner",
      defaultModel: "big",
      defaultEffort: "low",
    });
    expect(pick(defaults({ project: projectBig, agent: settingsSmall }))).toEqual({
      provider: "planner",
      model: "big",
      effort: "low",
    });
    // A project naming only its provider takes Settings' model and effort on that provider.
    const projectPlanner = projectWith({ defaultProvider: "planner" });
    expect(pick(defaults({ project: projectPlanner, agent: settingsSmall }))).toEqual({
      provider: "planner",
      model: "small",
      effort: "high",
    });
    // Neither sets one: the provider's default model and the model's own effort.
    expect(pick(defaults({ project: projectPlanner }))).toEqual({
      provider: "planner",
      model: "big",
      effort: null,
    });
    // What the draft picked wins over every default.
    const picked = choice({ provider: "planner", model: "small", effort: "medium" });
    expect(pick(defaults({ project: projectBig, agent: settingsSmall }), picked)).toEqual({
      provider: "planner",
      model: "small",
      effort: "medium",
    });
  });

  it("never applies a default model or effort on a provider it wasn't set for (#261)", () => {
    const pick = (d: DraftDefaults, c = choice()) => {
      const { provider, model, effort } = resolveDraftChoice(c, d);
      return { provider: provider?.id, model, effort };
    };
    // Settings names Planner's model, but the project defaults to Plain.
    const settingsSmall = agentOn("planner", "small", "high");
    const projectPlain = projectWith({ defaultProvider: "plain" });
    expect(pick(defaults({ project: projectPlain, agent: settingsSmall }))).toEqual({
      provider: "plain",
      model: "only",
      effort: null,
    });
    // The draft switched provider: neither the project's nor Settings' model follows it.
    const projectSmall = projectWith({
      defaultProvider: "planner",
      defaultModel: "small",
      defaultEffort: "high",
    });
    expect(
      pick(
        defaults({ project: projectSmall, agent: settingsSmall }),
        choice({ provider: "plain" }),
      ),
    ).toEqual({ provider: "plain", model: "only", effort: null });
    // Settings' provider isn't installed: its model isn't used on the first ready provider.
    expect(pick(defaults({ agent: agentOn("gone", "x", "high") }))).toEqual({
      provider: "planner",
      model: "big",
      effort: null,
    });
    // Effort is dropped on a provider without reasoning effort.
    expect(pick(defaults({ agent: agentOn("plain", "only", "high") }))).toEqual({
      provider: "plain",
      model: "only",
      effort: null,
    });
  });

  it("takes the autonomy picked, else the project's, else the Settings default", () => {
    const autonomy = (c: DraftChoice, d: DraftDefaults) => resolveDraftChoice(c, d).autonomy;
    expect(autonomy(choice(), defaults({ defaultAutonomy: "supervised" }))).toBe("supervised");
    const project = projectWith({ autonomy: "full" });
    expect(autonomy(choice(), defaults({ project }))).toBe("full");
    expect(autonomy(choice({ autonomy: "read_only" }), defaults({ project }))).toBe("read_only");
  });

  it("keeps Plan and effort only where the provider supports them", () => {
    const on = choice({ planMode: true, effort: "high" });
    expect(resolveDraftChoice(on, defaults())).toMatchObject({ planMode: true, effort: "high" });
    expect(resolveDraftChoice({ ...on, provider: "plain" }, defaults())).toMatchObject({
      planMode: false,
      effort: null,
    });
  });

  it("turns Plan off when the picker switches to a provider without plan mode", () => {
    const next = pickModel(
      choice({ planMode: true }),
      { provider: "plain", model: null, effort: null },
      [planner, plain],
    );
    expect(next).toMatchObject({ provider: "plain", planMode: false });
    // Switching back doesn't bring it back unseen.
    expect(
      pickModel(next, { provider: "planner", model: null, effort: null }, [planner, plain]),
    ).toMatchObject({ provider: "planner", planMode: false });
  });
});

describe("buildStartRequest", () => {
  const input = { text: "Add a README section" };

  it("sends what the old dialog sent for the defaults", () => {
    expect(buildStartRequest("p1", input, resolveDraftChoice(choice(), defaults()), "")).toEqual({
      projectId: "p1",
      input,
      autonomy: "auto",
      provider: "planner",
      model: "big",
    });
  });

  it("adds Plan, effort and the work key (trimmed) only when set", () => {
    const resolved = resolveDraftChoice(choice({ planMode: true, effort: "low" }), defaults());
    expect(buildStartRequest("p1", input, resolved, "  issue:151 ")).toEqual({
      projectId: "p1",
      input,
      autonomy: "auto",
      planMode: true,
      provider: "planner",
      model: "big",
      effort: "low",
      workKey: "issue:151",
    });
    expect(buildStartRequest("p1", input, resolved, "   ")).not.toHaveProperty("workKey");
  });

  it("carries the attachments of the first message", () => {
    const withImage = {
      text: "",
      attachments: [
        {
          type: "image" as const,
          mediaType: "image/png" as const,
          name: "shot.png",
          source: { type: "base64" as const, data: "AAAA" },
        },
      ],
    };
    const request = buildStartRequest(
      "p1",
      withImage,
      resolveDraftChoice(choice(), defaults()),
      "",
    );
    expect(request.input).toEqual(withImage);
  });

  it("turns an unpersisted conflict into a record the conflict card can retry", () => {
    const request = buildStartRequest(
      "p1",
      { text: "Fix the login bug\nmore detail" },
      resolveDraftChoice(choice(), defaults()),
      "",
    );
    const existing = [
      {
        kind: "session" as const,
        id: "s1",
        sessionId: "s1",
        projectId: "p1",
        startedBy: { kind: "user" as const },
        purpose: "Fix login",
        workKey: "request:fix-login",
        scope: { projectId: "p1" },
        progress: null,
        status: "running" as const,
        startedAt: "2026-11-12T10:00:00.000Z",
      },
    ];
    const record = localConflict(
      request,
      { status: "conflict", existing },
      new Date("2026-11-12T11:00:00.000Z"),
    );
    expect(record).toMatchObject({
      id: `local:${Date.parse("2026-11-12T11:00:00.000Z")}`,
      projectId: "p1",
      request: { purpose: "Fix the login bug", workKey: "request:fix-login" },
      start: request,
      status: "open",
    });
  });
});

describe("New session draft persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useNewSessionStore.setState({ drafts: {}, firstMessages: {} });
  });

  it("keeps New session draft text across a reload, without attachments or session drafts", () => {
    const image = {
      id: "a1",
      type: "image" as const,
      name: "shot.png",
      mediaType: "image/png" as const,
      data: "AAAA",
      previewUrl: "data:image/png;base64,AAAA",
    };
    expect(
      persistedDrafts({
        [newSessionDraftKey("p1")]: { text: "Write the docs", attachments: [image] },
        [newSessionDraftKey("p2")]: { text: "", attachments: [image] },
        "session-1": { text: "A follow-up", attachments: [] },
      }),
    ).toEqual({ [newSessionDraftKey("p1")]: { text: "Write the docs", attachments: [] } });
  });

  it("stores the options and work key in the browser, not the first messages", () => {
    const store = useNewSessionStore.getState();
    store.setChoice("p1", { provider: "plain", planMode: true });
    store.setWorkKey("p1", "issue:7");
    store.setFirstMessage("s1", { text: "hello" });
    const saved = JSON.parse(localStorage.getItem("codeden.new-session") ?? "{}");
    expect(saved.state).toEqual({
      drafts: {
        p1: { choice: { ...emptyChoice, provider: "plain", planMode: true }, workKey: "issue:7" },
      },
    });
    store.reset("p1");
    expect(useNewSessionStore.getState().drafts).toEqual({});
  });
});
