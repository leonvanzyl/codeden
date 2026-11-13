import { z } from "zod";
import { AutonomyLevel, ProviderId, QuietHours, ReasoningEffort } from "./common";
import { UpdateMode } from "./updates";
import { DictationEngine, WhisperModelId } from "./voice-api";

/** `auto` lets CodeDen pick the first ready provider (Claude, then Codex, then OpenCode). */
export const ProviderChoice = z.union([z.literal("auto"), ProviderId]);
export type ProviderChoice = z.infer<typeof ProviderChoice>;

/** Image engine choice (§12.5): `auto` picks Codex when logged in, `none` hides the tool. */
export const ImageEngineSetting = z.enum(["auto", "codex", "gemini", "openai", "none"]);
export type ImageEngineSetting = z.infer<typeof ImageEngineSetting>;

/**
 * What read-aloud speaks when a turn finishes (§11.3):
 * - `summary`: a spoken TL;DR of at most two short sentences from the utility model (§7.4),
 *   or the message's first sentence or two when the model can't produce one.
 * - `full`: the whole final message with code and markdown removed, no model call, capped at
 *   `READ_ALOUD_FULL_MAX_CHARS`.
 */
export const ReadAloudContent = z.enum(["summary", "full"]);
export type ReadAloudContent = z.infer<typeof ReadAloudContent>;

/** Hard cap on a spoken TL;DR, the model's output included (about 15 seconds of speech). */
export const READ_ALOUD_SUMMARY_MAX_CHARS = 220;
/** Safety cap on `full` read-aloud (roughly five minutes of speech). */
export const READ_ALOUD_FULL_MAX_CHARS = 5_000;

/**
 * Cut already-plain text to whole sentences within `maxChars`: as many leading sentences as fit,
 * or the first one cut at a word boundary with an ellipsis when even that is too long.
 */
export function speechExcerpt(plain: string, maxChars: number, maxSentences = Infinity): string {
  const text = plain.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const [i, sentence] of sentences.entries()) {
    if (i >= maxSentences) break;
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    out = next;
  }
  if (out) return out;
  const cut = text.slice(0, Math.max(0, maxChars - 3));
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "")}...`;
}

/** Per-project image generation override; unset fields fall back to the global settings. */
export const ImageGenerationOverride = z.object({
  engine: ImageEngineSetting.optional(),
  defaultSize: z.string().optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  /** Images per day for this project (counted on its own, inside the global cap). */
  dailyCap: z.int().nonnegative().optional(),
});
export type ImageGenerationOverride = z.infer<typeof ImageGenerationOverride>;

/** Default provider/model/effort for one role. */
export const RoleDefaults = z.object({
  provider: ProviderChoice.default("auto"),
  model: z.string().nullable().default(null),
  effort: ReasoningEffort.nullable().default(null),
});
export type RoleDefaults = z.infer<typeof RoleDefaults>;

/** A model named by its provider and the provider's model id. */
export const ModelRef = z.object({
  provider: ProviderId,
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * A model id the user added for a provider that doesn't list it (a new model, or one only
 * exposed through the provider's own config). The id is sent to the provider unchanged.
 */
export const CustomModel = z.object({
  id: z.string().trim().min(1).max(200),
  /** Shown instead of the id in the picker. */
  label: z.string().trim().min(1).max(100).optional(),
});
export type CustomModel = z.infer<typeof CustomModel>;

/** A provider's custom models: ids are unique. */
const CustomModelList = z
  .array(CustomModel)
  .refine((list) => new Set(list.map((m) => m.id)).size === list.length, {
    message: "Custom model ids must be unique",
  });

/**
 * User settings persisted in `<home>/settings.json` (non-secret; API keys live in the OS
 * keychain). Every field has a default, so `Settings.parse({})` yields a complete object and
 * older files keep working as fields are added.
 */
export const Settings = z.object({
  schemaVersion: z.literal(1).default(1),
  appearance: z
    .object({
      theme: z.enum(["system", "dark", "light"]).default("dark"),
    })
    .prefault({}),
  /** Default autonomy level (§11.2), overridable per project and session. */
  autonomy: z
    .object({
      default: AutonomyLevel.default("auto"),
    })
    .prefault({}),
  providers: z
    .object({
      orchestrator: RoleDefaults.prefault({}),
      pm: RoleDefaults.prefault({}),
      agent: RoleDefaults.prefault({}),
    })
    .prefault({}),
  /** Small, cheap model for side jobs (§7.4). */
  utilityModel: z
    .object({
      provider: ProviderChoice.default("auto"),
      model: z.string().nullable().default(null),
      jobs: z
        .object({
          followups: z.boolean().default(true),
          /**
           * @deprecated Superseded by `voice.readAloud.content` (§11.3) and no longer read. Kept
           * so settings files written before it was replaced still load.
           */
          readAloudSummary: z.boolean().default(true),
          sessionTitles: z.boolean().default(true),
          noticeSummaries: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  /** The model picker (§13). */
  models: z
    .object({
      /**
       * Starred models, listed in this order in the picker's Favourites section. Entries whose
       * model a provider no longer lists are kept (it may come back) but not shown.
       */
      favorites: z.array(ModelRef).default([]),
      /**
       * Model ids left out of the picker, by provider id. A hidden model that is still chosen
       * somewhere (a session, a default, an automation) keeps showing there.
       */
      hidden: z.record(ProviderId, z.array(z.string().min(1))).default({}),
      /**
       * Model ids added by the user, by provider id, merged into the picker after the models
       * the provider lists (a listed id wins). Their effort levels are those of the provider's
       * default model, or none when the provider has no effort levels.
       */
      custom: z.record(ProviderId, CustomModelList).default({}),
    })
    .prefault({}),
  /** Follow-up prompt chips (§7.5). */
  followups: z
    .object({
      enabled: z.boolean().default(true),
      /** Send immediately on click instead of filling the composer. */
      sendOnClick: z.boolean().default(false),
    })
    .prefault({}),
  /** Voice (§11.3). */
  voice: z
    .object({
      dictation: z
        .object({
          engine: DictationEngine.default("browser"),
          pushToTalkShortcut: z.string().nullable().default(null),
          /**
           * BCP 47 tag such as `en-US`; null is auto (the browser engine follows the browser
           * language, the server engines detect it). English-only Whisper models ignore it.
           */
          language: z.string().nullable().default(null),
          /** Local Whisper: which downloaded model transcribes (§11.3). */
          local: z
            .object({
              model: WhisperModelId.default("base.en"),
            })
            .prefault({}),
        })
        .prefault({}),
      readAloud: z
        .object({
          enabled: z.boolean().default(false),
          engine: z.enum(["browser", "elevenlabs"]).default("browser"),
          voice: z.string().nullable().default(null),
          /** What gets read when a turn finishes (§11.3); see `ReadAloudContent`. */
          content: ReadAloudContent.default("summary"),
          /**
           * Start each message with who it's from ("Orchestrator", "<project> project manager",
           * "<project>, <session title>"), built from the session, never by a model.
           */
          announceSpeaker: z.boolean().default(true),
          onlyWhenUnfocused: z.boolean().default(false),
          quietHours: QuietHours.nullable().default(null),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Image generation for every agent (§12.5). */
  imageGeneration: z
    .object({
      /** `auto`: Codex when logged in, else the first engine with a key; `none` hides the tool. */
      engine: ImageEngineSetting.default("auto"),
      defaultSize: z.string().default("1024x1024"),
      quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
      /** Images per day across all projects (0 turns generation off). */
      dailyCap: z.int().nonnegative().default(50),
      /** Overrides by project id. */
      projects: z.record(z.string(), ImageGenerationOverride).default({}),
    })
    .prefault({}),
  notifications: z
    .object({
      toasts: z.boolean().default(true),
      browser: z.boolean().default(false),
      /** A short chime when an agent is blocked on the user (an approval or a question). */
      sound: z.boolean().default(true),
      /**
       * Which inbox categories (`InboxItem.notify`) raise a toast and a desktop notification.
       * Approvals and questions always do while `toasts` / `browser` is on; switched-off
       * categories still land in the inbox. The factory looks after its own activity, so that
       * category is off by default.
       */
      categories: z
        .object({
          needs_you: z.boolean().default(true),
          failure: z.boolean().default(true),
          factory: z.boolean().default(false),
          automation: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Global factory controls (§10.1). */
  factory: z
    .object({
      /** Stops every project's factory loop and all factory sessions. */
      killSwitch: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Worktree cleanup (§9). Archiving a session removes its worktree (unless it has uncommitted changes and isn't forced); with `cleanup` on,
   * worktrees of sessions inactive for `afterDays` are removed too, unless the session's pull
   * request is still open or the worktree has uncommitted changes.
   */
  worktrees: z
    .object({
      cleanup: z.boolean().default(true),
      afterDays: z.int().min(1).max(365).default(7),
    })
    .prefault({}),
  /**
   * What CodeDen does by itself for agent sessions the user started (work started by a PM, the
   * orchestrator or an automation is followed up by the PM instead).
   */
  sessions: z
    .object({
      /**
       * Tell the session that owns a pull request when its checks fail, a reviewer requests
       * changes or it gets merge conflicts (once per head commit, at most a few rounds per PR).
       */
      prFeedback: z.boolean().default(true),
      /**
       * Continue an agent session by itself after a turn fails for a passing reason: an
       * overloaded API or dropped connection (after 20 s, 90 s and 5 min, then it gives up) or
       * a usage limit (a minute after it resets). Off: such a turn fails the session as before.
       */
      autoRetry: z.boolean().default(true),
    })
    .prefault({}),
  /** Master switch; individual automations are still off by default (§10). */
  automations: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Update checks and one-click self-update (§16). Settings saved before `mode` existed had
   * `check: false` to turn checks off; that reads as `mode: "off"`.
   */
  updates: z.preprocess(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !("mode" in value) &&
      (value as { check?: unknown }).check === false
        ? { mode: "off" }
        : value,
    z
      .object({
        mode: UpdateMode.default("notify"),
      })
      .prefault({}),
  ),
  /** The desktop app (§17). Read by the desktop app only; `npx codeden` ignores it. */
  desktop: z
    .object({
      /** Start CodeDen (in the tray, window hidden) when you log in. */
      launchAtLogin: z.boolean().default(false),
      /** Closing the window keeps CodeDen running in the tray / menu bar; Quit really quits. */
      closeToTray: z.boolean().default(true),
      /** Keep the computer from sleeping while an agent is running. */
      keepAwake: z.boolean().default(true),
      /**
       * Show session browsers as native browser views in the app (§17 Phase 2) instead of the
       * screencast. Applies to browsers opened from then on; off falls back to the screencast.
       */
      nativeBrowser: z.boolean().default(true),
    })
    .prefault({}),
  /** First-run setup (§14): set once the user finishes the detection checklist. */
  setup: z
    .object({
      completed: z.boolean().default(false),
      completedAt: z.iso.datetime().nullable().default(null),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof Settings>;
/** Settings as accepted on input: any subset, defaults fill the rest. */
export type SettingsInput = z.input<typeof Settings>;

/** Recursive partial used for `PATCH /api/settings`; validated by re-parsing the merged result. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type SettingsPatch = DeepPartial<Settings>;

/** Default settings. */
export function defaultSettings(): Settings {
  return Settings.parse({});
}
