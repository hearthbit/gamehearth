import { canonicalJson } from "./json";
import { readTrack, type MusicInstrument, type MusicTrack } from "./music";

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  setPeriodicWave(wave: object): void;
  start(when: number): void;
  stop(when: number): void;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when: number, offset: number): void;
  stop(when: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createPeriodicWave(real: Float32Array, imag: Float32Array): object;
}

export interface MusicTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MusicPlayerOptions {
  context: () => AudioContextLike | undefined;
  gain?: number;
  timers?: MusicTimers;
}

export interface MusicPlayer {
  readonly track: MusicTrack | null;
  readonly paused: boolean;
  play(track: MusicTrack | null): void;
  setPaused(paused: boolean): void;
  tick(): void;
  stop(): void;
}

export const musicPeakGain = 0.05;
export const musicCrossfadeSeconds = 1;
export const musicLookaheadSeconds = 1.5;
export const musicTickMs = 100;
export const musicChangeSeconds = 0.3;
export const musicLimiter = { threshold: -6, knee: 0, ratio: 20, attack: 0.003, release: 0.25 } as const;
export const musicMasterGain = 10 ** ((musicLimiter.threshold * (1 - 1 / musicLimiter.ratio) * 0.6) / 20);

const instrumentPeaks: Record<MusicInstrument, number> = {
  square: 0.6,
  sawtooth: 0.6,
  sine: 1,
  triangle: 1,
  musicbox: 1,
  organ: 0.8,
  pluck: 0.8,
  bass: 0.7,
  noise: 0.5,
};

const startDelay = 0.05;
const startFade = 0.05;
const pauseFade = 0.1;
const resumeFade = 0.3;
const lateSeconds = 0.05;
const minNoteSeconds = 0.03;
const silence = 0.0001;
const noiseSeconds = 2;
const flatLowpass = -3;

interface Event {
  time: number;
  duration: number;
  freq: number;
  to: number | undefined;
  peak: number;
  instrument: MusicInstrument;
}

interface Piece {
  key: string;
  track: MusicTrack;
  events: Event[];
  loop: number;
}

interface Source extends AudioNodeLike {
  stop(when: number): void;
}

interface Sounding {
  sources: Source[];
  nodes: AudioNodeLike[];
  until: number;
}

interface Instance {
  piece: Piece;
  out: GainNodeLike;
  origin: number;
  round: number;
  index: number;
  fade: { start: number; end: number; from: number; to: number };
  end: number | undefined;
  serial: number;
  sounding: Sounding[];
}

interface Extras {
  noise: AudioBufferLike;
  organ: object;
}

const extras = new WeakMap<AudioContextLike, Extras>();
const masters = new WeakMap<AudioContextLike, GainNodeLike>();

function extrasFor(context: AudioContextLike): Extras {
  const known = extras.get(context);
  if (known !== undefined) {
    return known;
  }
  const length = Math.max(1, Math.round(context.sampleRate * noiseSeconds));
  const noise = context.createBuffer(1, length, context.sampleRate);
  const data = noise.getChannelData(0);
  let seed = 0x2545f491;
  for (let index = 0; index < data.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data[index] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
  }
  const organ = context.createPeriodicWave(new Float32Array(5), Float32Array.from([0, 1, 0.5, 0.15, 0.3]));
  const created = { noise, organ };
  extras.set(context, created);
  return created;
}

function masterFor(context: AudioContextLike): GainNodeLike {
  const known = masters.get(context);
  if (known !== undefined) {
    return known;
  }
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(musicLimiter.threshold, 0);
  limiter.knee.setValueAtTime(musicLimiter.knee, 0);
  limiter.ratio.setValueAtTime(musicLimiter.ratio, 0);
  limiter.attack.setValueAtTime(musicLimiter.attack, 0);
  limiter.release.setValueAtTime(musicLimiter.release, 0);
  limiter.connect(context.destination);
  const master = context.createGain();
  master.gain.value = musicMasterGain;
  master.gain.setValueAtTime(musicMasterGain, 0);
  master.connect(limiter);
  masters.set(context, master);
  return master;
}

function piece(track: MusicTrack, gain: number): Piece | undefined {
  const normal = readTrack(track);
  if (normal === undefined) {
    return undefined;
  }
  const beat = 60 / normal.bpm;
  const events: Event[] = [];
  for (const voice of normal.voices) {
    for (const note of voice.notes) {
      const peak = gain * (voice.volume ?? 1) * (note.volume ?? 1);
      if (peak > 0) {
        events.push({ time: note.at * beat, duration: note.length * beat, freq: note.freq, to: note.to, peak, instrument: voice.instrument });
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { key: canonicalJson(normal), track: normal, events, loop: normal.beats * beat };
}

function sustain(param: AudioParamLike, when: number, end: number, peak: number, attack: number, release: number): void {
  const top = Math.min(when + attack, end);
  const hold = Math.max(top, end - release);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, top);
  param.setValueAtTime(peak, hold);
  param.linearRampToValueAtTime(0, end);
}

function decay(param: AudioParamLike, when: number, ring: number, peak: number, attack: number): void {
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.exponentialRampToValueAtTime(Math.max(peak * 0.001, silence), when + ring);
  param.setValueAtTime(0, when + ring);
}

function synthesize(context: AudioContextLike, out: AudioNodeLike, event: Event, when: number, serial: number, sounding: Sounding): void {
  const length = Math.max(event.duration, minNoteSeconds);
  const end = when + length;
  const release = Math.min(0.05, length / 3);
  const peak = event.peak * instrumentPeaks[event.instrument];
  const gainNode = (): GainNodeLike => {
    const node = context.createGain();
    sounding.nodes.push(node);
    node.connect(out);
    return node;
  };
  const filter = (type: string, frequency: number, q: number): BiquadFilterNodeLike => {
    const node = context.createBiquadFilter();
    sounding.nodes.push(node);
    node.type = type;
    node.Q.setValueAtTime(q, when);
    node.frequency.setValueAtTime(frequency, when);
    return node;
  };
  const oscillator = (type: string, destination: AudioNodeLike, stop: number, factor = 1): OscillatorNodeLike => {
    const node = context.createOscillator();
    node.type = type;
    node.frequency.setValueAtTime(event.freq * factor, when);
    if (event.to !== undefined) {
      node.frequency.exponentialRampToValueAtTime(event.to * factor, end);
    }
    node.connect(destination);
    node.start(when);
    node.stop(stop);
    sounding.sources.push(node);
    sounding.until = Math.max(sounding.until, stop);
    return node;
  };
  switch (event.instrument) {
    case "square":
    case "sawtooth":
    case "sine":
    case "triangle": {
      const envelope = gainNode();
      sustain(envelope.gain, when, end, peak, 0.008, release);
      oscillator(event.instrument, envelope, end + 0.02);
      return;
    }
    case "musicbox": {
      const ring = Math.min(2, Math.max(0.6, length + 0.3));
      const body = gainNode();
      decay(body.gain, when, ring, peak * 0.8, 0.003);
      oscillator("sine", body, when + ring + 0.02);
      const shine = gainNode();
      decay(shine.gain, when, ring / 3, peak * 0.2, 0.002);
      oscillator("sine", shine, when + ring / 3 + 0.02, 4);
      return;
    }
    case "organ": {
      const envelope = gainNode();
      sustain(envelope.gain, when, end, peak, 0.02, Math.min(0.08, length / 3));
      const wave = extrasFor(context).organ;
      oscillator("sine", envelope, end + 0.02).setPeriodicWave(wave);
      return;
    }
    case "pluck": {
      const ring = Math.min(1.5, Math.max(0.15, length + 0.1));
      const envelope = gainNode();
      decay(envelope.gain, when, ring, peak, 0.002);
      const lowpass = filter("lowpass", Math.min(event.freq * 8, 12000), flatLowpass);
      lowpass.frequency.exponentialRampToValueAtTime(Math.max(event.freq * 1.2, 60), when + ring / 2);
      lowpass.connect(envelope);
      oscillator("sawtooth", lowpass, when + ring + 0.02);
      return;
    }
    case "bass": {
      const envelope = gainNode();
      sustain(envelope.gain, when, end, peak, 0.01, release);
      const lowpass = filter("lowpass", Math.min(event.freq * 3, 1200), flatLowpass);
      lowpass.connect(envelope);
      oscillator("square", lowpass, end + 0.02);
      return;
    }
    case "noise": {
      const edge = Math.min(length / 4, 0.25);
      const envelope = gainNode();
      sustain(envelope.gain, when, end, peak, edge, edge);
      const bandpass = filter("bandpass", event.freq, 1.2);
      if (event.to !== undefined) {
        bandpass.frequency.exponentialRampToValueAtTime(event.to, end);
      }
      bandpass.connect(envelope);
      const buffer = extrasFor(context).noise;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(bandpass);
      source.start(when, (serial * 0.173) % noiseSeconds);
      source.stop(end + 0.02);
      sounding.sources.push(source);
      sounding.until = Math.max(sounding.until, end + 0.02);
      return;
    }
  }
}

function release(sounding: Sounding, now: number): void {
  for (const source of sounding.sources) {
    try {
      source.stop(now);
    } catch {
      continue;
    }
  }
  for (const node of [...sounding.sources, ...sounding.nodes]) {
    try {
      node.disconnect();
    } catch {
      continue;
    }
  }
}

export function createMusicPlayer(options: MusicPlayerOptions): MusicPlayer {
  const gain = options.gain ?? musicPeakGain;
  const timers = options.timers ?? (globalThis as unknown as MusicTimers);
  let input: MusicTrack | null = null;
  let wanted: Piece | undefined;
  let live: Instance | undefined;
  let fading: Instance | undefined;
  let paused = false;
  let resumeAt = 0;
  let lastChange = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let audio: AudioContextLike | undefined;
  let warned = false;

  const context = (): AudioContextLike | undefined => {
    audio = options.context() ?? audio;
    return audio;
  };

  const gainAt = (instance: Instance, time: number): number => {
    const { start, end, from, to } = instance.fade;
    if (time <= start) {
      return from;
    }
    if (time >= end) {
      return to;
    }
    return from + ((to - from) * (time - start)) / (end - start);
  };

  const drop = (instance: Instance, now: number): void => {
    for (const sounding of instance.sounding) {
      release(sounding, now);
    }
    instance.sounding = [];
    try {
      instance.out.disconnect();
    } catch {
      return;
    }
  };

  const fadeOut = (instance: Instance, seconds: number, now: number): void => {
    if (fading !== undefined) {
      drop(fading, now);
    }
    const from = gainAt(instance, now);
    instance.out.gain.cancelScheduledValues(now);
    instance.out.gain.setValueAtTime(from, now);
    instance.out.gain.linearRampToValueAtTime(0, now + seconds);
    instance.fade = { start: now, end: now + seconds, from, to: 0 };
    instance.end = now + seconds;
    fading = instance;
  };

  const begin = (audioContext: AudioContextLike, next: Piece, offset: number, fadeIn: number): Instance => {
    const now = audioContext.currentTime;
    const out = audioContext.createGain();
    out.connect(masterFor(audioContext));
    const start = now + startDelay;
    const position = next.loop > 0 ? offset % next.loop : 0;
    const index = next.events.findIndex((event) => event.time >= position);
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, start + fadeIn);
    return {
      piece: next,
      out,
      origin: start - position,
      round: index === -1 ? 1 : 0,
      index: index === -1 ? 0 : index,
      fade: { start: now, end: start + fadeIn, from: 0, to: 1 },
      end: undefined,
      serial: 0,
      sounding: [],
    };
  };

  const play = (audioContext: AudioContextLike, instance: Instance, event: Event, when: number): void => {
    const sounding: Sounding = { sources: [], nodes: [], until: when };
    try {
      synthesize(audioContext, instance.out, event, when, instance.serial, sounding);
    } catch (error) {
      release(sounding, audioContext.currentTime);
      if (!warned) {
        warned = true;
        (globalThis as { console?: { error(message: string): void } }).console?.error(
          `Music: a note could not be played and is skipped (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      return;
    }
    instance.sounding.push(sounding);
  };

  const schedule = (audioContext: AudioContextLike, instance: Instance, now: number): void => {
    instance.sounding = instance.sounding.filter((sounding) => {
      if (sounding.until < now - lateSeconds) {
        release(sounding, now);
        return false;
      }
      return true;
    });
    const { events, loop } = instance.piece;
    if (events.length === 0 || loop <= 0) {
      return;
    }
    const horizon = Math.min(now + musicLookaheadSeconds, instance.end ?? Number.POSITIVE_INFINITY);
    if (instance.origin + (instance.round + 1) * loop < now - lateSeconds) {
      instance.round = Math.floor((now - instance.origin) / loop);
      instance.index = 0;
    }
    for (;;) {
      const event = events[instance.index] as Event;
      const when = instance.origin + instance.round * loop + event.time;
      if (when >= horizon) {
        return;
      }
      if (when >= now - lateSeconds) {
        play(audioContext, instance, event, Math.max(when, now));
        instance.serial += 1;
      }
      instance.index += 1;
      if (instance.index >= events.length) {
        instance.index = 0;
        instance.round += 1;
      }
    }
  };

  const changing = (): boolean => !paused && live?.piece.key !== wanted?.key;

  const apply = (audioContext: AudioContextLike): void => {
    const now = audioContext.currentTime;
    if (!changing() || now < lastChange + musicChangeSeconds - 1e-9) {
      return;
    }
    lastChange = now;
    const previous = live;
    live = undefined;
    if (previous !== undefined) {
      fadeOut(previous, musicCrossfadeSeconds, now);
    }
    if (wanted !== undefined) {
      live = begin(audioContext, wanted, 0, previous === undefined ? startFade : musicCrossfadeSeconds);
    }
  };

  const tick = (): void => {
    const audioContext = audio;
    if (audioContext !== undefined) {
      apply(audioContext);
      const now = audioContext.currentTime;
      if (fading !== undefined && fading.end !== undefined && now >= fading.end + lateSeconds) {
        drop(fading, now);
        fading = undefined;
      }
      if (fading !== undefined) {
        schedule(audioContext, fading, now);
      }
      if (live !== undefined) {
        schedule(audioContext, live, now);
      }
    }
    const busy = live !== undefined || fading !== undefined || (audioContext !== undefined && changing());
    if (!busy && timer !== undefined) {
      timers.clearInterval(timer);
      timer = undefined;
    } else if (busy && timer === undefined) {
      timer = timers.setInterval(tick, musicTickMs);
    }
  };

  return {
    get track() {
      return wanted?.track ?? null;
    },
    get paused() {
      return paused;
    },
    play(track) {
      if (track !== null && track === input) {
        return;
      }
      input = track;
      const next = track === null ? undefined : piece(track, gain);
      if (next?.key === wanted?.key) {
        return;
      }
      wanted = next;
      resumeAt = 0;
      if (paused || (live === undefined && next === undefined)) {
        return;
      }
      const audioContext = context();
      if (audioContext === undefined) {
        return;
      }
      tick();
    },
    setPaused(next) {
      if (next === paused) {
        return;
      }
      paused = next;
      if (paused) {
        const audioContext = live === undefined ? undefined : context();
        if (live !== undefined && audioContext !== undefined) {
          const now = audioContext.currentTime;
          resumeAt = live.piece.loop > 0 ? Math.max(0, now - live.origin) % live.piece.loop : 0;
          fadeOut(live, pauseFade, now);
        }
        live = undefined;
      } else if (wanted !== undefined) {
        const audioContext = context();
        if (audioContext !== undefined) {
          live = begin(audioContext, wanted, resumeAt, resumeFade);
          lastChange = audioContext.currentTime;
        }
        resumeAt = 0;
      }
      tick();
    },
    tick,
    stop() {
      const now = audio?.currentTime ?? 0;
      for (const instance of [fading, live]) {
        if (instance !== undefined) {
          drop(instance, now);
        }
      }
      fading = undefined;
      live = undefined;
      wanted = undefined;
      input = null;
      resumeAt = 0;
      lastChange = Number.NEGATIVE_INFINITY;
      if (timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
