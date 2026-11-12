import type { ProviderCapabilities, ProviderInfo } from "@codeden/contracts";
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

const defaults = (over: Partial<DraftDefaults> = {}): DraftDefaults => ({
  providers: [planner, plain],
  project: { defaultProvider: null, autonomy: null },
  agentProvider: "auto",
  defaultAutonomy: "auto",
  ...over,
});
const choice = (over: Partial<DraftChoice> = {}): DraftChoice => ({ ...emptyChoice, ...over });

describe("resolveDraftChoice (the New session draft's defaults)", () => {
  it("picks the provider: chosen, then project default, then agent default, then the first", () => {
    const id = (c: DraftChoice, d: DraftDefaults) => resolveDraftChoice(c, d).provider?.id;
    expect(id(choice(), defaults())).toBe("planner");
    expect(id(choice(), defaults({ agentProvider: "plain" }))).toBe("plain");
    const projectPlain = { defaultProvider: "plain", autonomy: null };
    expect(id(choice(), defaults({ project: projectPlain, agentProvider: "planner" }))).toBe(
      "plain",
    );
    expect(
      id(
        choice({ provider: "planner" }),
        defaults({ project: projectPlain, agentProvider: "plain" }),
      ),
    ).toBe("planner");
    // A provider the runner doesn't list (gone, or a stale saved choice) is skipped.
    const gone = { defaultProvider: "gone", autonomy: null };
    expect(id(choice({ provider: "gone" }), defaults({ project: gone }))).toBe("planner");
    expect(resolveDraftChoice(choice(), defaults({ providers: [] })).provider).toBeUndefined();
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

  it("takes the autonomy picked, else the project's, else the Settings default", () => {
    const autonomy = (c: DraftChoice, d: DraftDefaults) => resolveDraftChoice(c, d).autonomy;
    expect(autonomy(choice(), defaults({ defaultAutonomy: "supervised" }))).toBe("supervised");
    const project = { defaultProvider: null, autonomy: "full" as const };
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
