import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerBox } from "@/components/composer/composer-box";
import { ShortcutRecorder } from "@/components/settings/voice-controls";
import type { CodeDenClient } from "@/lib/api/client";
import { createMockClient } from "@/lib/api/mock";
import { createBrowserStt, type SpeechToText } from "@/lib/voice/engines";
import type { SamplesListener } from "@/lib/voice/mic-capture";
import { createSegmentedStt } from "@/lib/voice/segmented-stt";
import { getDraft, useComposerStore } from "@/stores/composer";
import { renderWithClient } from "./utils";

const RATE = 16_000;
const tone = (ms: number, amp: number) =>
  Float32Array.from(
    { length: (RATE * ms) / 1000 },
    (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE),
  );
/** A phrase followed by a pause long enough to end its segment. */
const phrase = () => {
  const out = new Float32Array(tone(700, 0.3).length + tone(800, 0.001).length);
  out.set(tone(700, 0.3));
  out.set(tone(800, 0.001), tone(700, 0.3).length);
  return out;
};

const KEY = "s-live-dictation";
const textbox = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const mic = () => screen.getByRole("button", { name: /^(Dictate|Stop dictation|Transcribing)/ });

function renderComposer(engine: SpeechToText, client?: CodeDenClient) {
  return renderWithClient(
    <ComposerBox
      draftKey={KEY}
      placeholder="Message the agent"
      onKeyDown={() => {}}
      dictationEngine={engine}
    >
      <span />
    </ComposerBox>,
    client,
  );
}

/** The mock client with a push-to-talk shortcut set in Settings > Voice. */
function withPushToTalk(combo: string): CodeDenClient {
  const client = createMockClient();
  return {
    ...client,
    getSnapshot: async () => {
      const s = await client.getSnapshot();
      s.settings.voice.dictation.pushToTalkShortcut = combo;
      return s;
    },
  };
}

beforeEach(() => {
  useComposerStore.setState({ drafts: {} });
  useComposerStore.getState().setText(KEY, "Fix");
});

describe("live dictation in the composer", () => {
  it("shows text phrase by phrase while speaking, and the joined segments after stop", async () => {
    let feed: SamplesListener = () => {};
    const replies = ["the flaky test", "in checkout", "please"];
    const transcribe = vi.fn(async () => replies[transcribe.mock.calls.length - 1] ?? "");
    const engine = createSegmentedStt({
      supported: true,
      capture: async (onSamples) => {
        feed = onSamples;
        return { stop: () => {} };
      },
      transcribe,
    });
    renderComposer(engine);
    fireEvent.click(mic());
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    // Before any text: a "Listening…" indicator, then a live level once audio arrives.
    expect(screen.getByRole("status").textContent).toMatch(/^Listening…/);
    await act(async () => feed(tone(200, 0.001), RATE));
    expect(screen.getByTestId("dictation-level")).toBeTruthy();

    await act(async () => feed(phrase(), RATE));
    await waitFor(() => expect(textbox().value).toBe("Fix the flaky test"));
    // Still listening: the text arrived before stop.
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    await act(async () => feed(phrase(), RATE));
    await waitFor(() => expect(textbox().value).toBe("Fix the flaky test in checkout"));

    // Stop mid-phrase: the last segment is flushed and transcribed.
    await act(async () => feed(tone(500, 0.3), RATE));
    fireEvent.click(mic());
    await waitFor(() => expect(screen.queryByTestId("dictation-strip")).toBeNull());
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(textbox().value).toBe("Fix the flaky test in checkout please");
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe(
      "Fix the flaky test in checkout please",
    );
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("shows text in progress muted, outside the draft, until it settles", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "interim",
      finishesAfterStop: false,
      start: (o) => {
        handlers = o;
      },
      stop: vi.fn(),
    };
    renderComposer(engine);
    fireEvent.click(mic());
    // No level from this engine: a pulsing dot and "Listening…".
    expect(screen.queryByTestId("dictation-level")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Listening…");
    act(() => handlers?.onText({ final: "", draft: "the fla" }));
    expect(screen.getByTestId("dictation-draft").textContent).toBe("the fla");
    expect(textbox().value).toBe("Fix");
    act(() => handlers?.onText({ final: "the flaky test", draft: "" }));
    expect(textbox().value).toBe("Fix the flaky test");
    expect(screen.queryByTestId("dictation-draft")).toBeNull();
    fireEvent.click(mic());
    expect(engine.stop).toHaveBeenCalled();
    expect(screen.queryByTestId("dictation-strip")).toBeNull();
  });

  it("adds no space between typed and dictated text in a language written without spaces", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "segments",
      finishesAfterStop: false,
      start: (o) => {
        handlers = o;
      },
      stop: vi.fn(),
    };
    useComposerStore.getState().setText(KEY, "请修复");
    renderComposer(engine);
    fireEvent.click(mic());
    act(() => handlers?.onText({ final: "不稳定的测试", draft: "" }));
    expect(textbox().value).toBe("请修复不稳定的测试");
  });

  it("waits for the last segments after stop, then keeps the text when an error ends dictation", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "segments",
      finishesAfterStop: true,
      start: (o) => {
        handlers = o;
      },
      stop: vi.fn(),
    };
    renderComposer(engine);
    fireEvent.click(mic());
    act(() => handlers?.onText({ final: "the flaky test", draft: "" }));
    act(() => handlers?.onPending?.(1));
    expect(screen.getByRole("status").textContent).toBe("Transcribing…");
    fireEvent.click(mic());
    expect(mic().getAttribute("aria-label")).toBe("Transcribing…");
    expect((mic() as HTMLButtonElement).disabled).toBe(true);
    act(() => handlers?.onError("The network is down."));
    act(() => handlers?.onEnd());
    expect(textbox().value).toBe("Fix the flaky test");
    expect((mic() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("dictation-strip")).toBeNull();
  });

  it("is disabled when no engine is available", () => {
    const engine: SpeechToText = {
      supported: false,
      live: "interim",
      finishesAfterStop: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
    renderComposer(engine);
    const button = screen.getByRole("button", { name: /^Dictation isn't available/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("push-to-talk", () => {
  // Ctrl+Shift+Space as the shortcut recorder in Settings > Voice saves it. Both modifier
  // flags are set so the combo's `mod` matches on any platform.
  const COMBO = "mod+shift+space";
  const held = { key: " ", code: "Space", ctrlKey: true, metaKey: true, shiftKey: true };

  it("starts on keydown and stops when the main key is released", async () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "interim",
      finishesAfterStop: false,
      start: vi.fn<SpeechToText["start"]>((o) => {
        handlers = o;
      }),
      stop: vi.fn(),
    };
    renderComposer(engine, withPushToTalk(COMBO));
    // The shortcut shows on the button once Settings have loaded.
    await screen.findByRole("button", { name: /· hold Ctrl Shift space$/ });

    fireEvent.keyDown(window, held);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    // Holding the keys repeats keydown; dictation doesn't restart.
    fireEvent.keyDown(window, { ...held, repeat: true });
    expect(engine.start).toHaveBeenCalledTimes(1);

    act(() => handlers?.onText({ final: "the flaky test", draft: "" }));
    // Letting go of a modifier first keeps listening; only the main key ends it.
    fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft", ctrlKey: true, metaKey: true });
    expect(engine.stop).not.toHaveBeenCalled();
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyUp(window, { key: " ", code: "Space", ctrlKey: true, metaKey: true });
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    expect(textbox().value).toBe("Fix the flaky test");
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe("Fix the flaky test");
  });

  it("leaves a key without a modifier to typing in the composer", async () => {
    // A bare key, as the recorder used to save (or a hand-edited settings file has).
    const engine: SpeechToText = {
      supported: true,
      live: "interim",
      finishesAfterStop: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
    renderComposer(engine, withPushToTalk("space"));
    await screen.findByRole("button", { name: /· hold space$/ });

    textbox().focus();
    // fireEvent returns false when a handler called preventDefault (the space isn't typed).
    const typed = fireEvent.keyDown(textbox(), { key: " ", code: "Space" });
    expect(typed).toBe(true);
    expect(engine.start).not.toHaveBeenCalled();
    expect(mic().getAttribute("aria-pressed")).toBe("false");

    // Outside a text field the key still holds to dictate.
    expect(fireEvent.keyDown(window, { key: " ", code: "Space" })).toBe(false);
    expect(engine.start).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { key: " ", code: "Space" });
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a dictation started with the button going while its main key is typed", async () => {
    const engine: SpeechToText = {
      supported: true,
      live: "interim",
      finishesAfterStop: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
    renderComposer(engine, withPushToTalk(COMBO));
    await screen.findByRole("button", { name: /· hold Ctrl Shift space$/ });

    fireEvent.click(mic());
    textbox().focus();
    fireEvent.keyDown(textbox(), { key: " ", code: "Space" });
    fireEvent.keyUp(textbox(), { key: " ", code: "Space" });
    expect(engine.stop).not.toHaveBeenCalled();
    expect(mic().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("push-to-talk shortcut recorder", () => {
  const recorder = () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value={null} onChange={onChange} />);
    const button = screen.getByRole("button", { name: "Push-to-talk shortcut" });
    fireEvent.click(button);
    return { onChange, button };
  };

  it.each([
    [
      "Ctrl+Shift+Space",
      { key: " ", code: "Space", ctrlKey: true, shiftKey: true },
      "mod+shift+space",
    ],
    ["Alt+D", { key: "d", code: "KeyD", altKey: true }, "alt+d"],
    ["an F key on its own", { key: "F8", code: "F8" }, "f8"],
  ])("records %s", (_, keys, combo) => {
    const { onChange, button } = recorder();
    fireEvent.keyDown(button, keys);
    expect(onChange).toHaveBeenCalledWith(combo);
  });

  it.each([
    ["Space", { key: " ", code: "Space" }],
    ["a letter", { key: "a", code: "KeyA" }],
    ["Shift and a letter", { key: "A", code: "KeyA", shiftKey: true }],
    ["Enter", { key: "Enter", code: "Enter" }],
  ])("doesn't save %s on its own, which would take over that key", (_, keys) => {
    const { onChange, button } = recorder();
    fireEvent.keyDown(button, keys);
    expect(onChange).not.toHaveBeenCalled();
    expect(button.textContent).toContain("Add Ctrl or Alt…");
    // Still recording: a combo with a modifier is saved.
    fireEvent.keyDown(button, { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith("mod+shift+space");
  });
});

describe("browser speech recognition in the composer", () => {
  /** The browser's recognition, scripted: the test fires its results and its end. */
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    stopped = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      FakeRecognition.last = this;
    }
    stop() {
      this.stopped = true;
    }
  }
  const w = window as unknown as { SpeechRecognition?: unknown };
  beforeEach(() => {
    FakeRecognition.last = null;
    w.SpeechRecognition = FakeRecognition;
  });
  afterEach(() => {
    delete w.SpeechRecognition;
  });

  it("keeps interim words the service never finalised when recognition ends", () => {
    renderComposer(createBrowserStt());
    fireEvent.click(mic());
    const rec = FakeRecognition.last;
    expect(rec?.interimResults).toBe(true);

    act(() =>
      rec?.onresult?.({
        resultIndex: 0,
        results: {
          length: 2,
          0: { isFinal: true, 0: { transcript: "the flaky test" } },
          1: { isFinal: false, 0: { transcript: " in checkout" } },
        },
      }),
    );
    // Interim words show muted, outside the draft.
    expect(textbox().value).toBe("Fix the flaky test");
    expect(screen.getByTestId("dictation-draft").textContent).toBe("in checkout");

    fireEvent.click(mic());
    expect(rec?.stopped).toBe(true);
    // The browser ends recognition after stop without finalising them: they join the draft.
    act(() => rec?.onend?.());
    expect(textbox().value).toBe("Fix the flaky test in checkout");
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe("Fix the flaky test in checkout");
    expect(screen.queryByTestId("dictation-strip")).toBeNull();
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });
});
