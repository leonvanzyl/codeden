import { randomBytes } from "node:crypto";
import { LocalSttStatus, SttResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FakeDownloads,
  makeTgz,
  makeWav,
  sha256,
  startFakeDownloads,
} from "./support/fake-downloads";
import { type Harness, startHarness, TOKEN, waitUntil } from "./support/harness";

describe("local Whisper routes", () => {
  let fake: FakeDownloads;
  let h: Harness;
  const tarball = makeTgz({ "package/index.node": Buffer.from("addon") });
  const model = randomBytes(64_000);

  beforeAll(async () => {
    fake = await startFakeDownloads();
    fake.files.set("/runtime.tgz", { body: tarball });
    fake.files.set("/tiny.en.bin", { body: model });
    h = await startHarness({
      localStt: {
        platform: "test-x64",
        runtimePins: {
          "test-x64": {
            version: "1.0.0",
            url: `${fake.url}/runtime.tgz`,
            sha256: sha256(tarball),
            bytes: tarball.length,
            entry: "package/index.node",
          },
        },
        models: [
          {
            id: "tiny.en",
            file: "ggml-tiny.en.bin",
            url: `${fake.url}/tiny.en.bin`,
            sha256: sha256(model),
            bytes: model.length,
            label: "Tiny (English)",
            hint: "Fastest",
            englishOnly: true,
            recommended: true,
          },
        ],
        loadRuntime: async () => ({
          loadModel: async () => ({
            transcribe: async (pcm) => ({
              text: `${pcm.byteLength / 32_000}s of speech`,
              language: "en",
            }),
            release: async () => {},
          }),
        }),
      },
    });
  });

  afterAll(async () => {
    await h?.close();
    await fake?.close();
  });

  const stt = (path: string, body: RequestInit["body"], type?: string) =>
    fetch(`${h.server.url}/api/stt${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, ...(type ? { "content-type": type } : {}) },
      body,
    });

  it("downloads a model, transcribes WAV uploads and deletes it", async () => {
    const initial = LocalSttStatus.parse((await h.api("GET", "/voice/local")).body);
    expect(initial.models).toMatchObject([{ id: "tiny.en", state: "missing" }]);
    expect((await h.api("POST", "/voice/local/models/large/download")).status).toBe(400);

    // Not downloaded yet: a clear 409.
    await h.api("PATCH", "/settings", { voice: { dictation: { local: { model: "tiny.en" } } } });
    const early = await stt("?engine=local", makeWav({ seconds: 1 }), "audio/wav");
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "model_not_installed" } });

    const started = await h.api("POST", "/voice/local/models/tiny.en/download");
    expect(started.status).toBe(200);
    const installed = await waitUntil(async () => {
      const s = LocalSttStatus.parse((await h.api("GET", "/voice/local")).body);
      return s.models[0]?.state === "installed" ? s : undefined;
    });
    expect(installed.runtime.state).toBe("installed");

    // The configured engine is used when the request names none.
    await h.api("PATCH", "/settings", { voice: { dictation: { engine: "local" } } });
    const res = await stt("", makeWav({ seconds: 2 }), "audio/wav");
    expect(res.status).toBe(200);
    const body = SttResponse.parse(await res.json());
    expect(body).toMatchObject({ text: "2s of speech", language: "en", engine: "local" });
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);

    const form = new FormData();
    form.append("file", new Blob([makeWav({ seconds: 1 })], { type: "audio/wav" }), "clip.wav");
    const multipart = SttResponse.parse(await (await stt("?engine=local", form)).json());
    expect(multipart.text).toBe("1s of speech");

    const webm = await stt("?engine=local", Buffer.from("not a wav"), "audio/webm");
    expect(webm.status).toBe(415);
    expect(await webm.json()).toMatchObject({ error: { code: "unsupported_audio" } });
    const stereo = await stt("?engine=local", makeWav({ channels: 2 }), "audio/wav");
    expect(stereo.status).toBe(415);
    const long = await stt("?engine=local", makeWav({ seconds: 125 }), "audio/wav");
    expect(long.status).toBe(413);

    const removed = LocalSttStatus.parse(
      (await h.api("DELETE", "/voice/local/models/tiny.en")).body,
    );
    expect(removed.models[0]?.state).toBe("missing");
    expect((await stt("", makeWav({ seconds: 1 }), "audio/wav")).status).toBe(409);
  });
});
