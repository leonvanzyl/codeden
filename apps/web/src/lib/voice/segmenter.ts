/**
 * Splits live microphone audio into segments on short pauses (§11.3), so a server engine can
 * transcribe each phrase as soon as it ends instead of the whole recording on stop. Pure and
 * synchronous: push mono samples in, get finished segments back.
 *
 * Speech is told from silence by the energy (RMS) of each short frame, against a threshold that
 * follows the room's noise floor, seeded from the first audio so a noisy room isn't taken for
 * speech while the floor learns it. When the first gap between words shows that soft speech set
 * the seed, the audio so far is judged again, so the first word isn't lost. A segment keeps a
 * short lead-in before its first speech and a short tail after its last, so words aren't
 * clipped. One with too little speech is dropped, so silence and clicks never reach Whisper,
 * which tends to invent text for silence.
 */

export interface SegmenterOptions {
  /** Samples per second of the audio pushed in. */
  sampleRate: number;
  /** One analysis frame, in ms. */
  frameMs?: number;
  /** Silence after speech that ends a segment, in ms. */
  pauseMs?: number;
  /** Speech a segment needs to be kept, in ms. */
  minSpeechMs?: number;
  /** Audio kept before a segment's first speech, in ms. */
  leadInMs?: number;
  /** Silence kept after a segment's last speech, in ms. */
  tailMs?: number;
  /** Longest segment: longer speech is cut at its quietest recent moment, in ms. */
  maxSegmentMs?: number;
  /** Frames at or below this RMS are silence however quiet the room is. */
  minThreshold?: number;
}

export const SEGMENTER_DEFAULTS = {
  frameMs: 20,
  pauseMs: 600,
  minSpeechMs: 250,
  leadInMs: 200,
  tailMs: 300,
  maxSegmentMs: 25_000,
  minThreshold: 0.01,
} satisfies Omit<Required<SegmenterOptions>, "sampleRate">;

/** Speech is at least this many times louder than the noise floor. */
const NOISE_RATIO = 2.5;
/** The noise floor rises towards louder frames over about this long, in ms. */
const NOISE_RISE_MS = 10_000;
/** How far back a forced cut looks for the quietest frame, in ms. */
const CUT_SEARCH_MS = 2_000;
/**
 * At least this much of the first audio, in ms, is held to seed the noise floor before any of
 * it is judged. The floor would otherwise rise from zero for seconds, and a room louder than
 * `minThreshold` would count as speech until it caught up.
 */
const SEED_MS = 200;
/** The seed is the quiet end of the held audio: this share of its frames are quieter. */
const SEED_QUANTILE = 0.1;
/** A start whose median energy is at most this is a quiet room, and seeds the floor at once. */
const QUIET_SEED_MAX = 0.02;
/**
 * A louder start is a loud room or speech already under way when the microphone opens. Speech
 * dips between words, so it seeds as soon as its quiet end is `NOISE_RATIO` below its median.
 * A room's hum stays loud, so a start still that steady after this long, in ms (longer than
 * speech goes without a dip), is the room, and seeds at its own level.
 */
const LOUD_SEED_MS = 2_000;
/**
 * Before the seed, frames at or below this RMS (-80 dBFS) are a microphone still starting up:
 * zeros or near-zeros far below any room, which say nothing of it.
 */
const STARTUP_SILENCE = 1e-4;
/**
 * For this long from the first audio (startup silence aside), until a segment is sent, every
 * frame is kept. Soft speech already under way in a quiet start set the seed itself and stays
 * under it; the first gap between words drops the floor, and once audio judged silent would
 * count as speech against the lower floor, all of it is judged again, so the first word isn't
 * lost. It counts from the first audio, not the seed, so a loud start held until it showed
 * itself to be the room is never judged again. In ms.
 */
const RECHECK_MS = 2_000;

export interface Segmenter {
  /** Add samples; returns the segments they finished (usually none). */
  push(samples: Float32Array): Float32Array[];
  /** Close the open segment (on stop); returns it when it holds enough speech. */
  flush(): Float32Array[];
  /** RMS of the latest frame, 0..1: the input level for a meter. */
  readonly level: number;
}

interface Frame {
  samples: Float32Array;
  speech: boolean;
  rms: number;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function concat(frames: Frame[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.samples.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f.samples, at);
    at += f.samples.length;
  }
  return out;
}

function trailingSilence(frames: Frame[]): number {
  let n = 0;
  while (n < frames.length && !frames[frames.length - 1 - n]?.speech) n++;
  return n;
}

export function createSegmenter(options: SegmenterOptions): Segmenter {
  const o = { ...SEGMENTER_DEFAULTS, ...options };
  const frameLength = Math.max(1, Math.round((o.sampleRate * o.frameMs) / 1000));
  const frames = (ms: number) => Math.max(1, Math.round(ms / o.frameMs));
  const pauseFrames = frames(o.pauseMs);
  const minSpeechFrames = frames(o.minSpeechMs);
  const leadInFrames = frames(o.leadInMs);
  const tailFrames = frames(o.tailMs);
  const maxFrames = Math.max(frames(o.maxSegmentMs), pauseFrames + 1);
  const cutSearchFrames = Math.min(frames(CUT_SEARCH_MS), maxFrames - 1);
  const noiseRise = Math.min(1, o.frameMs / NOISE_RISE_MS);
  const seedFrames = frames(SEED_MS);
  const loudSeedFrames = frames(LOUD_SEED_MS);

  let partial = new Float32Array(frameLength);
  let partialLength = 0;
  let noise = 0;
  let level = 0;
  /** The first frames, held until they seed the noise floor; null once it is seeded. */
  let seed: Omit<Frame, "speech">[] | null = [];
  /** Every frame judged so far, while they can still be judged again (`RECHECK_MS`); else null. */
  let history: Frame[] | null = [];
  /** Frames, from the first audio, that may still have the start judged again. */
  let recheckLeft = frames(RECHECK_MS);
  /** Recent silent frames while no segment is open: the next segment's lead-in. */
  let leadIn: Frame[] = [];
  /** The open segment; empty when none is open. */
  let open: Frame[] = [];

  /** End the open segment, keeping `tailFrames` of its trailing silence. */
  const close = (): Float32Array | null => {
    const silent = trailingSilence(open);
    const end = open.length - silent + Math.min(silent, tailFrames);
    const kept = open.slice(0, end);
    const speech = kept.filter((f) => f.speech).length;
    leadIn = open.slice(end).slice(-leadInFrames);
    open = [];
    return speech >= minSpeechFrames ? concat(kept) : null;
  };

  /** The open segment is too long: cut it at its quietest recent frame, keep the rest open. */
  const cut = (): Float32Array | null => {
    let at = open.length - 1;
    for (let i = open.length - 1; i >= open.length - cutSearchFrames; i--) {
      if ((open[i]?.rms ?? Infinity) < (open[at]?.rms ?? Infinity)) at = i;
    }
    const done = open.slice(0, at + 1);
    open = open.slice(at + 1);
    const speech = done.filter((f) => f.speech).length;
    return speech >= minSpeechFrames ? concat(done) : null;
  };

  const threshold = () => Math.max(o.minThreshold, noise * NOISE_RATIO);

  /** Judge one frame against the floor; returns the segment it finished, if any. */
  const step = (samples: Float32Array, r: number, learn: boolean): Float32Array | null => {
    const speech = r > threshold();
    // The floor drops to quiet frames at once and rises slowly, so it follows the room (the
    // quiet between words), not the voice.
    if (learn) noise = r < noise ? noise + (r - noise) * 0.5 : noise + (r - noise) * noiseRise;
    const f: Frame = { samples, speech, rms: r };
    history?.push(f);
    if (open.length === 0) {
      if (!speech) {
        leadIn.push(f);
        if (leadIn.length > leadInFrames) leadIn.shift();
        return null;
      }
      open = leadIn;
      leadIn = [];
    }
    open.push(f);
    const segment =
      trailingSilence(open) >= pauseFrames ? close() : open.length >= maxFrames ? cut() : null;
    // Audio already sent is never judged again.
    if (segment) history = null;
    return segment;
  };

  /**
   * The floor has dropped (a gap between words) below audio already judged silent: soft speech
   * set the seed. Judge every frame so far again against the floor as it is now.
   */
  const recheck = (out: Float32Array[]) => {
    if (!history) return;
    if (--recheckLeft < 0) {
      history = null;
      return;
    }
    const now = threshold();
    if (!history.some((f) => !f.speech && f.rms > now)) return;
    const heard = history;
    history = [];
    leadIn = [];
    open = [];
    // They were learned from already, so they don't move the floor again.
    for (const f of heard) {
      const segment = step(f.samples, f.rms, false);
      if (segment) out.push(segment);
    }
  };

  /** The held frames' RMS, quietest first. */
  const seedLevels = (): number[] => (seed ?? []).map((f) => f.rms).sort((a, b) => a - b);
  /** The level that a share `q` (0..1) of `sorted` is quieter than. */
  const quantile = (sorted: number[], q: number): number =>
    sorted[Math.floor(sorted.length * q)] ?? 0;

  /** Whether the held frames tell the room's level: see `QUIET_SEED_MAX` and `LOUD_SEED_MS`. */
  const seedReady = (): boolean => {
    const levels = seedLevels();
    if (levels.length < seedFrames) return false;
    const median = quantile(levels, 0.5);
    return (
      median <= QUIET_SEED_MAX ||
      quantile(levels, SEED_QUANTILE) * NOISE_RATIO <= median ||
      levels.length >= loudSeedFrames
    );
  };

  /** Seed the floor from the held frames, then judge them against it. */
  const seedFloor = (out: Float32Array[]) => {
    noise = quantile(seedLevels(), SEED_QUANTILE);
    const held = seed ?? [];
    seed = null;
    // They are the seed, so they don't move the floor again.
    for (const f of held) {
      const segment = step(f.samples, f.rms, false);
      if (segment) out.push(segment);
    }
  };

  const frame = (samples: Float32Array, out: Float32Array[]) => {
    const r = rms(samples);
    level = Math.min(1, r);
    if (seed && (seed.length > 0 || r > STARTUP_SILENCE)) {
      seed.push({ samples, rms: r });
      // The held audio is the start too, so it counts towards `RECHECK_MS`.
      recheckLeft--;
      if (seedReady()) seedFloor(out);
      return;
    }
    const segment = step(samples, r, true);
    if (segment) out.push(segment);
    // Only a seeded floor can have been set by speech (startup silence comes before the seed).
    if (!seed) recheck(out);
  };

  return {
    get level() {
      return level;
    },
    push(samples) {
      const out: Float32Array[] = [];
      let i = 0;
      while (i < samples.length) {
        const take = Math.min(frameLength - partialLength, samples.length - i);
        partial.set(samples.subarray(i, i + take), partialLength);
        partialLength += take;
        i += take;
        if (partialLength === frameLength) {
          frame(partial, out);
          partial = new Float32Array(frameLength);
          partialLength = 0;
        }
      }
      return out;
    },
    flush() {
      const out: Float32Array[] = [];
      // Stopped before the floor was seeded: seed it from what was heard.
      if (seed) seedFloor(out);
      if (partialLength > 0 && open.length > 0) frame(partial.slice(0, partialLength), out);
      partial = new Float32Array(frameLength);
      partialLength = 0;
      if (open.length > 0) {
        const segment = close();
        if (segment) out.push(segment);
      }
      leadIn = [];
      history = null;
      return out;
    },
  };
}
