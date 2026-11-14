import type { Snapshot } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Loader2, Mic, Volume2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings/settings-ui";
import { ProjectSourcePicker } from "@/components/setup/add-project-dialog";
import { SetupChecklist, useSetupStatus } from "@/components/setup/checklist";
import { useClaudeSdkStatus, useInstallClaudeSdk } from "@/components/setup/claude-support";
import { LocalWhisperCard } from "@/components/setup/local-whisper-card";
import { NotificationsRow } from "@/components/setup/notifications-row";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { snapshotKey } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { stt, tts } from "@/lib/voice/engines";

const STEPS = ["Check your tools", "Voice & notifications", "First project"];

function Extras() {
  const { settings, update } = useSettings();
  const readAloudId = useId();
  const row = "flex items-center gap-3 px-4 py-3.5";
  const browserStt = stt.supported;
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
      <div className={row}>
        <Mic className="size-4 text-muted-foreground" />
        <div className="flex-1">
          <div className="text-[13.5px] font-medium">Dictation</div>
          <div className="text-2xs text-muted-foreground">
            {browserStt
              ? "Your browser supports speech to text. Press Ctrl Shift M in the composer."
              : "This browser has no speech recognition. Use local Whisper below, or a cloud engine in Settings."}
          </div>
        </div>
        <span className={cn("text-2xs", browserStt ? "text-status-done" : "text-muted-foreground")}>
          {browserStt ? "Available" : "Unavailable"}
        </span>
      </div>
      <LocalWhisperCard recommended={!browserStt} />
      <div className={row}>
        <Volume2 className="size-4 text-muted-foreground" />
        <div className="flex-1">
          <div id={`${readAloudId}-label`} className="text-[13.5px] font-medium">
            Read final messages aloud
          </div>
          <div id={`${readAloudId}-hint`} className="text-2xs text-muted-foreground">
            When a turn completes and you're in another tab.
          </div>
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={!tts.supported}
          onClick={() => tts.speak("Hi! I'll read agent summaries like this.")}
        >
          Test
        </Button>
        <Switch
          aria-labelledby={`${readAloudId}-label`}
          aria-describedby={`${readAloudId}-hint`}
          checked={settings.voice.readAloud.enabled}
          onCheckedChange={(enabled) => update({ voice: { readAloud: { enabled } } })}
        />
      </div>
      <NotificationsRow />
    </div>
  );
}

/** First-run setup (§14): from `npx codeden` to a first session in under a minute. */
export function SetupPage() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const status = useSetupStatus();
  const ready = status.data?.ready ?? false;
  // Claude Code support installs when the user continues with Claude Code detected (§14).
  const claudeInstalled = status.data?.checks.some((c) => c.id === "claude" && c.installed);
  const sdk = useClaudeSdkStatus(claudeInstalled === true).data;
  const installSdk = useInstallClaudeSdk();
  const [waitingForSdk, setWaitingForSdk] = useState(false);
  useEffect(() => {
    if (!waitingForSdk || sdk?.state === "installing") return;
    setWaitingForSdk(false);
    if (sdk?.state === "ready") setStep(1);
  }, [waitingForSdk, sdk?.state]);
  const next = async () => {
    if (
      step === 0 &&
      claudeInstalled &&
      (sdk?.state === "missing" || sdk?.state === "installing")
    ) {
      const started = sdk.state === "missing" ? await installSdk() : sdk;
      if (started?.state === "ready") setStep(1);
      else if (started?.state === "installing") setWaitingForSdk(true);
      return;
    }
    setStep(step + 1);
  };
  const finish = async (projectId?: string) => {
    const completedAt = new Date().toISOString();
    // Mirror it right away so "/" doesn't bounce back here while the server catches up.
    queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
      s ? { ...s, settings: { ...s.settings, setup: { completed: true, completedAt } } } : s,
    );
    try {
      await client.completeSetup();
      // `/setup/complete` saves without a live event; the settings PATCH broadcasts
      // `settings.updated`, so every open tab (and a later snapshot) agrees.
      const settings = await client.updateSettings({ setup: { completed: true, completedAt } });
      queryClient.setQueryData<Snapshot>(snapshotKey, (s) => (s ? { ...s, settings } : s));
    } catch (error) {
      toast.error("Setup wasn't saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    // A first project leads straight into its first session: the New session view (§14).
    void navigate(
      projectId ? { to: "/projects/$projectId/new", params: { projectId } } : { to: "/" },
    );
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-y-auto bg-background px-6 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(50%_100%_at_50%_0%,var(--glow),transparent)]"
      />
      <div className="relative w-full max-w-2xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="mb-4 size-12" />
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to CodeDen</h1>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            We'll reuse what's already set up on this machine. Nothing to type if you're already
            signed in.
          </p>
        </div>

        <ol className="mb-6 flex items-center justify-center gap-2">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => i <= step && setStep(i)}
                className={cn(
                  "flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-xs transition-colors",
                  i === step ? "bg-accent text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full text-3xs font-semibold",
                    i < step
                      ? "bg-status-done/15 text-status-done"
                      : i === step
                        ? "bg-primary text-primary-foreground"
                        : "border border-border",
                  )}
                >
                  {i < step ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                {label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-6 bg-border" />}
            </li>
          ))}
        </ol>

        {step === 0 && <SetupChecklist />}
        {step === 1 && <Extras />}
        {step === 2 && (
          <ProjectSourcePicker
            submitLabel="Add project & finish"
            onCreated={(id) => void finish(id)}
          />
        )}

        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => void finish()}>
            Skip setup
          </Button>
          {step < 2 ? (
            <Button disabled={(step === 0 && !ready) || waitingForSdk} onClick={() => void next()}>
              {waitingForSdk
                ? "Installing Claude Code support…"
                : step === 0 && claudeInstalled && sdk?.state === "failed"
                  ? "Continue anyway"
                  : step === 1 || ready
                    ? "Continue"
                    : "Waiting for a provider…"}{" "}
              {waitingForSdk ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void finish()}>
              I'll add a project later
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
