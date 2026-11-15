import { READ_ALOUD_FULL_MAX_CHARS } from "@codeden/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { formatCombo, shortcut } from "@/lib/shortcuts";
import { browserSttAvailability, resetBrowserSttAvailability, tts } from "@/lib/voice/engines";
import { speak, speechQueue } from "@/lib/voice/speak";
import { SecretField, useSecrets } from "./secret-field";
import { LocalWhisperRows } from "./sections-voice-local";
import { Segmented, SettingRow, SettingsSection, useSettings } from "./settings-ui";
import { QuietHoursRow, ShortcutRecorder } from "./voice-controls";

const LANGUAGES = ["auto", "en-US", "en-GB", "en-ZA", "de-DE", "fr-FR", "es-ES", "nl-NL"];

/** Browser voices, refreshed when the browser finishes loading them. */
function useBrowserVoices() {
  const [voices, setVoices] = useState(() => tts.voices());
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => setVoices(tts.voices());
    window.speechSynthesis.addEventListener("voiceschanged", load);
    load();
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

export function VoiceSettings() {
  const client = useClient();
  const { settings, update } = useSettings();
  const v = settings.voice;
  const browserVoices = useBrowserVoices();
  const secrets = useSecrets();
  const has = (key: string) => secrets.data?.keys.some((k) => k.key === key && k.set) ?? false;
  const cloudTts = v.readAloud.engine === "elevenlabs";
  const voices = useQuery({
    queryKey: ["eleven-voices", has("elevenlabs.apiKey")],
    queryFn: () => client.voice.voices(),
    enabled: cloudTts && has("elevenlabs.apiKey"),
    retry: false,
  });
  const voiceOptions = cloudTts
    ? (voices.data?.voices ?? []).map((vo) => ({ id: vo.id, label: vo.name }))
    : browserVoices.map((vo) => ({ id: vo.id, label: `${vo.label} (${vo.lang})` }));
  const testVoice = useMutation({
    // Plays straight away, ahead of (and stopping) any queued read-aloud.
    mutationFn: async () =>
      speechQueue.playNow({
        key: `test-${Date.now()}`,
        play: () =>
          speak(
            client,
            settings,
            "The checkout flake is fixed and verified with fifty green runs.",
          ).catch((e: Error) => {
            toast.error("Couldn't play the voice", { description: e.message });
          }),
      }),
  });
  const dictationKey = v.dictation.engine === "openai" ? "openai.apiKey" : "elevenlabs.apiKey";
  const browserAvailable = browserSttAvailability() === "available";

  return (
    <>
      <SettingsSection
        title="Dictation"
        description={`Speech to text in the composer. Toggle with ${formatCombo(shortcut("dictate").combo)}, or hold a push-to-talk shortcut.`}
      >
        <SettingRow
          label="Engine"
          help={
            v.dictation.engine === "browser" ? (
              browserAvailable ? (
                "The browser engine works in Chrome and Edge."
              ) : (
                <span data-testid="browser-stt-unavailable">
                  Speech recognition isn't available here.{" "}
                  <button
                    type="button"
                    className="text-foreground underline underline-offset-2"
                    onClick={() => update({ voice: { dictation: { engine: "local" } } })}
                  >
                    Use Local (Whisper)
                  </button>
                  , which runs on this machine, or a cloud engine.
                </span>
              )
            ) : v.dictation.engine === "local" ? (
              "Runs Whisper on this machine through the CodeDen server; audio never leaves it."
            ) : has(dictationKey) ? (
              "Transcribes each phrase through the CodeDen server as you pause, so text appears while you speak."
            ) : (
              `Add the ${v.dictation.engine === "openai" ? "OpenAI" : "ElevenLabs"} key below to use this engine.`
            )
          }
        >
          <Segmented
            value={v.dictation.engine}
            onChange={(engine) => {
              // Picking the browser engine again gives a remembered failure another try.
              if (engine === "browser") resetBrowserSttAvailability();
              update({ voice: { dictation: { engine } } });
            }}
            options={[
              {
                value: "browser",
                label:
                  browserAvailable || v.dictation.engine === "browser"
                    ? "Browser"
                    : "Browser (unavailable)",
              },
              { value: "local", label: "Local (Whisper)" },
              { value: "elevenlabs", label: "ElevenLabs" },
              { value: "openai", label: "OpenAI" },
            ]}
          />
        </SettingRow>
        {v.dictation.engine === "local" && <LocalWhisperRows />}
        <SettingRow
          label="Language"
          help={
            v.dictation.engine === "browser"
              ? "Leave on auto to follow the browser language."
              : "Auto detects the spoken language. English-only Whisper models always use English."
          }
        >
          <Select
            value={v.dictation.language ?? "auto"}
            onValueChange={(language) =>
              update({ voice: { dictation: { language: language === "auto" ? null : language } } })
            }
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Dictation language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l === "auto" ? "Auto" : l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Push-to-talk"
          help={`Hold to dictate, release to stop. Click, then press a key with ${formatCombo("mod")} or ${formatCombo("alt")} (or an F key).`}
        >
          <ShortcutRecorder
            value={v.dictation.pushToTalkShortcut}
            onChange={(pushToTalkShortcut) =>
              update({ voice: { dictation: { pushToTalkShortcut } } })
            }
          />
        </SettingRow>
        {v.dictation.engine === "openai" && (
          <SettingRow
            label="OpenAI API key"
            help="Shared with OpenAI Images. Stored in the OS keychain."
          >
            <SecretField secret="openai.apiKey" label="OpenAI key" />
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="Read aloud"
        description="Speaks an agent's final message when any session finishes a turn, with code and markdown stripped."
      >
        <SettingRow
          label="Read final messages aloud"
          help="Messages play one after another; switching this off stops the current one. Mute single sessions from their Details tab."
        >
          <Switch
            aria-label="Read final messages aloud"
            checked={v.readAloud.enabled}
            onCheckedChange={(enabled) => {
              // Switching it off also stops what's playing and drops the queue.
              if (!enabled) speechQueue.clear();
              update({ voice: { readAloud: { enabled } } });
            }}
          />
        </SettingRow>
        <SettingRow
          label="What to read"
          help={
            v.readAloud.content === "summary"
              ? "A one or two sentence TL;DR from the utility model: what was done and whether it needs you."
              : `The whole final message, up to ${READ_ALOUD_FULL_MAX_CHARS.toLocaleString("en-US")} characters (about five minutes).`
          }
        >
          <Segmented
            value={v.readAloud.content}
            onChange={(content) => update({ voice: { readAloud: { content } } })}
            options={[
              { value: "summary", label: "TL;DR" },
              { value: "full", label: "Full message" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Say who's speaking"
          help="Starts each message with who it's from, such as the project manager or a session's title."
        >
          <Switch
            aria-label="Say who's speaking"
            checked={v.readAloud.announceSpeaker}
            onCheckedChange={(announceSpeaker) =>
              update({ voice: { readAloud: { announceSpeaker } } })
            }
          />
        </SettingRow>
        <SettingRow label="Engine">
          <Segmented
            value={v.readAloud.engine}
            // Voice ids differ per engine, so switching resets the voice.
            onChange={(engine) => update({ voice: { readAloud: { engine, voice: null } } })}
            options={[
              { value: "browser", label: "Browser (free)" },
              { value: "elevenlabs", label: "ElevenLabs" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Voice"
          help={
            cloudTts && !has("elevenlabs.apiKey")
              ? "Add your ElevenLabs key below to load its voices."
              : voices.error
                ? voices.error.message
                : undefined
          }
        >
          <div className="flex items-center gap-2">
            <Select
              value={v.readAloud.voice ?? "default"}
              onValueChange={(voice) =>
                update({ voice: { readAloud: { voice: voice === "default" ? null : voice } } })
              }
            >
              <SelectTrigger size="sm" className="w-56" aria-label="Read-aloud voice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {cloudTts ? "Default voice" : "System default"}
                </SelectItem>
                {voiceOptions.slice(0, 60).map((vo) => (
                  <SelectItem key={vo.id} value={vo.id}>
                    {vo.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={
                (cloudTts ? !has("elevenlabs.apiKey") : !tts.supported) || testVoice.isPending
              }
              onClick={() => testVoice.mutate()}
            >
              <Volume2 /> Test
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="Only when the tab isn't focused">
          <Switch
            aria-label="Only when the tab isn't focused"
            checked={v.readAloud.onlyWhenUnfocused}
            onCheckedChange={(onlyWhenUnfocused) =>
              update({ voice: { readAloud: { onlyWhenUnfocused } } })
            }
          />
        </SettingRow>
        <QuietHoursRow />
        <SettingRow
          label="ElevenLabs API key"
          help="Optional, for ElevenLabs voices and dictation. Stored in the OS keychain."
        >
          <SecretField secret="elevenlabs.apiKey" label="ElevenLabs key" />
        </SettingRow>
      </SettingsSection>
    </>
  );
}
