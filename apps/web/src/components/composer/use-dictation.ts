import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings/settings-ui";
import { useClient } from "@/lib/api";
import { isTyping, leavesTypingAlone, matchesCombo, shortcut } from "@/lib/shortcuts";
import { createCloudStt } from "@/lib/voice/cloud-stt";
import { stt as browserStt, type SpeechToText } from "@/lib/voice/engines";
import { separator } from "@/lib/voice/segment-queue";

/** `listening` while the microphone is on; `finishing` while the last text is still coming. */
export type DictationPhase = "idle" | "listening" | "finishing";

/** The microphone level (RMS, 0..1), kept outside React state so only the meter re-renders. */
export interface LevelStore {
  /** `null` when the engine doesn't report a level. */
  get(): number | null;
  set(level: number | null): void;
  subscribe(listener: () => void): () => void;
}

function createLevelStore(): LevelStore {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(level) {
      if (level === value) return;
      value = level;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface Dictation {
  engine: SpeechToText;
  phase: DictationPhase;
  /** Text in progress, shown muted; not in the draft yet. */
  draft: string;
  /** Segments still being transcribed. */
  pending: number;
  /** Whether any text arrived in this dictation. */
  heard: boolean;
  level: LevelStore;
  /** The dictate shortcut and the push-to-talk shortcut (if set). */
  combo: string;
  pushToTalk: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

/**
 * The dictation engine from Settings: the browser's, or a server engine (cloud or local
 * Whisper) through `/api/stt`.
 */
function useDictationEngine(override?: SpeechToText): SpeechToText {
  const client = useClient();
  const { settings } = useSettings();
  const choice = settings.voice.dictation.engine;
  return useMemo(() => {
    if (override) return override;
    if (choice === "browser") return browserStt;
    return createCloudStt(client, choice);
  }, [override, choice, client]);
}

/**
 * Dictation into the composer (§11.3): starts and stops the engine (button, toggle shortcut or
 * push-to-talk), writes settled text after whatever was typed before dictating, and tracks
 * what the composer shows while it runs: the text in progress, segments being transcribed and
 * the microphone level. What it shows comes from the engine's capabilities, never its id.
 */
export function useDictation({
  baseText,
  onText,
  language,
  engine: override,
}: {
  baseText: string;
  onText: (text: string) => void;
  language?: string | null;
  engine?: SpeechToText;
}): Dictation {
  const engine = useDictationEngine(override);
  const { settings } = useSettings();
  const pushToTalk = settings.voice.dictation.pushToTalkShortcut ?? null;
  const combo = shortcut("dictate").combo;
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(0);
  const [heard, setHeard] = useState(false);
  const [level] = useState(createLevelStore);
  const phaseRef = useRef<DictationPhase>("idle");
  /** Whether the push-to-talk shortcut started this dictation (so releasing it stops it). */
  const held = useRef(false);
  const move = (next: DictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const start = () => {
    if (!engine.supported || phaseRef.current !== "idle") return;
    held.current = false;
    // Text goes after what was typed before dictating, into the draft that was open then.
    const typed = baseText.trimEnd();
    const write = (dictated: string) =>
      onText(typed ? typed + separator(typed, dictated) + dictated : dictated);
    move("listening");
    setDraft("");
    setPending(0);
    setHeard(false);
    level.set(null);
    engine.start({
      language,
      onText: (text) => {
        setDraft(text.draft);
        if (text.final || text.draft) setHeard(true);
        if (text.final) write(text.final);
      },
      onLevel: (value) => level.set(value),
      onPending: setPending,
      onEnd: () => {
        move("idle");
        setDraft("");
        setPending(0);
        level.set(null);
      },
      onError: (message) => {
        // The engine still ends after an error; until then the last segments may come back.
        if (phaseRef.current !== "idle") move(engine.finishesAfterStop ? "finishing" : "idle");
        toast.error("Dictation stopped", { description: message });
      },
    });
  };
  const stop = () => {
    if (phaseRef.current !== "listening") return;
    move(engine.finishesAfterStop ? "finishing" : "idle");
    engine.stop();
  };
  const toggle = () => (phaseRef.current === "listening" ? stop() : start());

  const handlers = useRef({ toggle, start, stop });
  handlers.current = { toggle, start, stop };
  useEffect(() => {
    // A push-to-talk key without Ctrl/⌘ or Alt (saved before the recorder required one) would
    // swallow that key in the composer and every other text field; there it types instead.
    const typingWins = (e: KeyboardEvent) =>
      pushToTalk !== null && !leavesTypingAlone(pushToTalk) && isTyping(e.target);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!engine.supported) return;
      if (pushToTalk && matchesCombo(e, pushToTalk) && !typingWins(e)) {
        e.preventDefault();
        if (!e.repeat && phaseRef.current === "idle") {
          handlers.current.start();
          held.current = true;
        }
        return;
      }
      if (matchesCombo(e, combo)) {
        e.preventDefault();
        handlers.current.toggle();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Releasing the shortcut's main key ends the dictation it started; one started with the
      // button or the dictate shortcut keeps going while that key is typed.
      if (!pushToTalk || !held.current) return;
      const key = pushToTalk.split("+").at(-1)?.toLowerCase();
      if (key && (e.key.toLowerCase() === key || e.code.toLowerCase() === key))
        handlers.current.stop();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [combo, pushToTalk, engine.supported]);

  // Leaving the composer (or switching engines) releases the microphone; text still coming
  // goes into the draft dictation started in.
  useEffect(
    () => () => {
      if (phaseRef.current === "listening") engine.stop();
    },
    [engine],
  );

  return {
    engine,
    phase,
    draft,
    pending,
    heard,
    level,
    combo,
    pushToTalk,
    start,
    stop,
    toggle,
  };
}
