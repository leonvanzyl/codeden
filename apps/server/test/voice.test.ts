import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SttResponse, VoiceListResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, TOKEN } from "./support/harness";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

/** Stands in for the ElevenLabs and OpenAI APIs. */
async function startStub(seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const url = new URL(req.url ?? "/", "http://stub");
      if (req.headers["xi-api-key"] === "bad" || req.headers.authorization === "Bearer bad") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ detail: { message: "Invalid API key" } }));
      }
      if (url.pathname === "/v2/voices") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            voices: [
              {
                voice_id: "v1",
                name: "Ada",
                category: "premade",
                preview_url: "https://x/p.mp3",
                labels: { accent: "british" },
              },
            ],
          }),
        );
      }
      if (url.pathname.startsWith("/v1/text-to-speech/")) {
        res.setHeader("content-type", "audio/mpeg");
        res.write(Buffer.from("ID3-part-1"));
        setTimeout(() => res.end(Buffer.from("-part-2")), 20);
        return;
      }
      if (url.pathname === "/v1/speech-to-text") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ text: " hello there ", language_code: "en" }));
      }
      if (url.pathname === "/v1/audio/transcriptions") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ text: "from openai" }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("cloud voice proxy (TTS, voices, STT)", () => {
  const seen: Seen[] = [];
  let stub: { server: Server; url: string };
  let h: Harness;

  beforeAll(async () => {
    stub = await startStub(seen);
    h = await startHarness({ voice: { elevenLabsBaseUrl: stub.url, openAiBaseUrl: stub.url } });
  });

  afterAll(async () => {
    await h?.close();
    stub?.server.closeAllConnections();
    await new Promise((r) => stub?.server.close(r));
  });

  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${h.server.url}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });

  it("asks for a key first", async () => {
    const res = await h.api("GET", "/voice/voices");
    expect(res).toMatchObject({ status: 409, body: { error: { code: "missing_api_key" } } });
  });

  it("lists voices and streams speech with the keychain key", async () => {
    await h.api("PUT", "/secrets/elevenlabs.apiKey", { value: "el-key" });
    const voices = VoiceListResponse.parse((await h.api("GET", "/voice/voices")).body);
    expect(voices.voices).toEqual([
      {
        id: "v1",
        name: "Ada",
        category: "premade",
        previewUrl: "https://x/p.mp3",
        labels: { accent: "british" },
      },
    ]);
    await h.api("PATCH", "/settings", { voice: { readAloud: { voice: "v1" } } });
    const res = await raw("/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Done." }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ID3-part-1-part-2");
    const call = seen.find((s) => s.url.startsWith("/v1/text-to-speech/"));
    expect(call?.url).toBe("/v1/text-to-speech/v1/stream?output_format=mp3_44100_128");
    expect(call?.headers["xi-api-key"]).toBe("el-key");
    expect(JSON.parse(call?.body.toString() ?? "{}")).toEqual({
      text: "Done.",
      model_id: "eleven_flash_v2_5",
    });
  });

  it("transcribes raw audio with Scribe and multipart audio with OpenAI", async () => {
    const audio = Buffer.from("fake-webm-audio");
    const scribe = SttResponse.parse(
      await (
        await raw("/stt?language=en", {
          method: "POST",
          headers: { "content-type": "audio/webm" },
          body: audio,
        })
      ).json(),
    );
    expect(scribe).toEqual({ text: "hello there", language: "en", engine: "elevenlabs" });
    const sttCall = seen.find((s) => s.url === "/v1/speech-to-text");
    const form = sttCall?.body.toString() ?? "";
    expect(form).toContain('name="model_id"');
    expect(form).toContain("scribe_v2");
    expect(form).toContain('filename="speech.webm"');
    expect(form).toContain("fake-webm-audio");

    await h.api("PUT", "/secrets/openai.apiKey", { value: "oa-key" });
    const body = new FormData();
    body.append("file", new Blob([audio], { type: "audio/ogg" }), "clip.ogg");
    const openai = SttResponse.parse(
      await (await raw("/stt?engine=openai", { method: "POST", body })).json(),
    );
    expect(openai).toMatchObject({ text: "from openai", engine: "openai" });
    const oaCall = seen.find((s) => s.url === "/v1/audio/transcriptions");
    expect(oaCall?.headers.authorization).toBe("Bearer oa-key");
    expect(oaCall?.body.toString()).toContain("gpt-4o-mini-transcribe");
  });

  it("reports provider errors without leaking the key", async () => {
    await h.api("PUT", "/secrets/elevenlabs.apiKey", { value: "bad" });
    const res = await h.api("GET", "/voice/voices");
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).toContain("Invalid API key");
    expect(JSON.stringify(res.body)).not.toContain('"bad"');
    const empty = await raw("/stt", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "",
    });
    expect(empty.status).toBe(400);
  });
});
