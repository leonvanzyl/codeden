# Voice and image generation

## Voice

Both directions sit behind swappable engines. The defaults are free and run in your browser; cloud engines are opt-in and their API keys stay in the OS keychain, never in the browser.

### Dictation (speech to text)

- Click the **microphone** in the composer, or press **Ctrl/Cmd+Shift+M** to start and stop.
- **Push-to-talk:** set a key combination in **Settings → Voice**, then hold it to dictate and release to stop. The combination needs Ctrl/Cmd or Alt (or is a function key such as F8), so it never takes over a key you type with.
- **Engines:**

| Engine | Needs | Notes |
|---|---|---|
| Browser (default) | A browser with the Web Speech API (Chrome, Edge) | Free |
| Local (Whisper) | A one-off download (about 58 MB for the default model) | Free, offline, works in any browser and the desktop app |
| ElevenLabs | An ElevenLabs API key | Scribe transcription |
| OpenAI | An OpenAI API key (shared with OpenAI Images) | `gpt-4o-mini-transcribe` |

- **Language:** leave it on auto to follow the browser (or, for server engines, to detect the language), or pick one.
- **Text appears as you speak.** The Browser engine shows words as it hears them. Local (Whisper), ElevenLabs and OpenAI show text phrase by phrase: each time you pause briefly, the phrase you just said is transcribed and added. Words still in progress show in muted italics under your message and join it once they're final. A level meter and "Listening…" show that the microphone hears you before any text arrives. Stopping adds the last phrase, and if dictation fails partway, the text already transcribed stays.

Cloud dictation captures the microphone in the browser and sends each phrase to the CodeDen server, which forwards it to the provider with your key. Each piece of audio is sent once, so it costs the same as sending the whole recording. The key never reaches the page.

If your browser has no working speech recognition (Firefox, the desktop app), the Browser engine is marked unavailable and Settings suggests Local (Whisper).

### Local Whisper

Whisper runs on your own machine through the CodeDen server; your audio never leaves it.

1. In **Settings → Voice**, choose **Local (Whisper)** (or turn on **Use local Whisper for dictation** during first-run setup).
2. Pick a model and press **Download**. CodeDen downloads a small runtime for your platform (about 1.3 MB) and the model, checks both against pinned SHA-256 checksums and shows the progress. You can keep working meanwhile; an interrupted download resumes where it stopped.
3. Press **Test**, say a sentence, and see the transcript and how long it took.

| Model | Download | Speed and accuracy |
|---|---|---|
| Tiny / Tiny (English) | 31 MB | Fastest, lower accuracy |
| **Base (English)** (default) / Base | 57 MB | Fast, good accuracy |
| Small / Small (English) | 181 MB | Slower, best accuracy |

- "(English)" models only transcribe English and are the most accurate choice for it; the others handle many languages.
- Files live in `~/.codeden/deps/whisper/` (runtime) and `~/.codeden/models/whisper/` (models). **Delete** in Settings removes a model.
- Supported on Windows, macOS and Linux (x64 and arm64). Linux needs glibc 2.34 or newer (Ubuntu 22.04+, Debian 12+) and `libgomp1`.
- The runtime is whisper.cpp built as a Node add-on (from the npm registry); models come from Hugging Face. Neither needs an account.

### Read-aloud (text to speech)

When an agent's turn completes, CodeDen can read its final message aloud.

- Turn it on in **Settings → Voice → Read final messages aloud**. It's off by default.
- Code blocks and Markdown are stripped.
- **What to read** chooses between:
  - **TL;DR** (default): a one or two sentence summary from the [utility model](workbench.md#the-utility-model) saying what was done and whether anything needs you, about 15 seconds at most. Short messages are read as they are. If the summary can't be made, the message's first sentence or two are read instead, never the whole report; the reason is written to the server log.
  - **Full message**: the whole final message, up to 5,000 characters (about five minutes).
- **Say who's speaking** (on by default) starts each message with who it's from, such as "Orchestrator", "codeden project manager" or "codeden-website, Improve FAQ" (the project and the session's title).
- Messages from different sessions **queue** instead of cutting each other off: each plays to the end, then the next. If several finish at once, only the latest three wait. Turning read-aloud off stops the current message and clears the queue; muting a session stops its message.
- **Only when the tab isn't focused** keeps it quiet while you're looking.
- **Mute one session** from its **Details** tab.
- **Engines:** the browser's built-in voices (default, free) or ElevenLabs (pick a voice from your account).
- Quiet hours can be set with `voice.readAloud.quietHours` (`{ "start": "22:00", "end": "07:00" }`) in `settings.json`.

## Image generation

Every agent gets one `generate_image` tool, whatever its own provider can do. A Claude agent building a landing page can create its hero image; a PM can mock up an idea.

### Engines

| Engine | Needs | Default model |
|---|---|---|
| **Codex** | Your existing Codex login, no API key | your configured Codex model |
| **Gemini** | A Google AI API key | `gemini-nano-banana-2.1` |
| **OpenAI Images** | An OpenAI API key | `gpt-image-2` |

Choose in **Settings → Image generation**:

- **Engine:** `auto` (Codex when you're logged in, otherwise the first engine with a key), a specific engine, or `none` to hide the tool from agents. An engine you chose explicitly is never silently swapped for another.
- **Default size** (`1024x1024`) and **quality** (`auto`, `low`, `medium`, `high`).
- **Daily cap** across all projects (default 50; 0 turns generation off).
- **API keys** for Gemini and OpenAI, stored in the OS keychain.
- **Test the active engine:** generates one small image (it counts toward today's cap).

Per-project overrides (engine, size, quality and a project cap) live in `settings.json` under `imageGeneration.projects.<projectId>`.

If no engine is available, the tool is **hidden** from agents rather than failing when they call it.

### What the tool does

```text
generate_image({
  prompt: "A warm, minimal hero illustration of a cosy reading nook",
  aspectRatio: "16:9",          // or size: "1536x1024"
  count: 1,
  referenceImages: [...],       // optional, for edits and variations
  outputPath: "public/hero.png" // inside the worktree; default generated-images/
})
```

- Agents write into **their worktree** (default `generated-images/`). Paths outside it, inside `.git`, or through a symlink that escapes are refused. The orchestrator and PMs write to `~/.codeden/generated/<session>/`.
- File extensions follow the actual image bytes (`hero.png`, `hero-2.png`, ...).
- Every image is also saved as an **artifact** and shown inline in the chat (pass `share: false` to skip that).
- Images are reserved against the daily caps before the engine runs and released if it fails.

### Codex engine notes

- It runs a short, tool-restricted Codex turn under your own login: no MCP servers, plugins or web search, a read-only sandbox, no approvals. Codex returns the image and CodeDen writes the file itself.
- Expect roughly 20 to 40 seconds for one image.
- Sizes are approximate: "square" comes back around 1254x1254, landscape 1536x1024, portrait 1024x1536.
- Codex keeps its own copy of each image under `~/.codex/generated_images/`; CodeDen removes those copies.
- Usage-limit errors are reported with the time the limit resets.
