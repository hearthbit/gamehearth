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
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createPeriodicWave(real: number[], imag: number[]): object;
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
export const musicLookaheadSeconds = 0.5;
export const musicTickMs = 100;

const startDelay = 0.05;
const startFade = 0.05;
const pauseFade = 0.1;
const resumeFade = 0.3;
const cutFade = 0.05;
const lateSeconds = 0.05;
const minNoteSeconds = 0.03;
const silence = 0.0001;
const noiseSeconds = 2;

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

interface Instance {
  piece: Piece;
  out: GainNodeLike;
  origin: number;
  round: number;
  index: number;
  fade: { start: number; end: number; from: number; to: number };
  end: number | undefined;
  serial: number;
}

interface Extras {
  noise: AudioBufferLike;
  organ: object;
}

const extras = new WeakMap<AudioContextLike, Extras>();

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
  const organ = context.createPeriodicWave([0, 0, 0, 0, 0], [0, 1, 0.5, 0.15, 0.3]);
  const created = { noise, organ };
  extras.set(context, created);
  return created;
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

function oscillator(context: AudioContextLike, type: string, event: Event, when: number, end: number, stop: number, factor = 1): OscillatorNodeLike {
  const node = context.createOscillator();
  node.type = type;
  node.frequency.setValueAtTime(event.freq * factor, when);
  if (event.to !== undefined) {
    node.frequency.exponentialRampToValueAtTime(event.to * factor, end);
  }
  node.start(when);
  node.stop(stop);
  return node;
}

function gainNode(context: AudioContextLike, destination: AudioNodeLike): GainNodeLike {
  const node = context.createGain();
  node.connect(destination);
  return node;
}

function synthesize(context: AudioContextLike, out: AudioNodeLike, event: Event, when: number, serial: number): void {
  const length = Math.max(event.duration, minNoteSeconds);
  const end = when + length;
  const release = Math.min(0.05, length / 3);
  switch (event.instrument) {
    case "square":
    case "sawtooth":
    case "sine":
    case "triangle": {
      const envelope = gainNode(context, out);
      sustain(envelope.gain, when, end, event.peak * (event.instrument === "square" || event.instrument === "sawtooth" ? 0.6 : 1), 0.008, release);
      oscillator(context, event.instrument, event, when, end, end + 0.02).connect(envelope);
      return;
    }
    case "musicbox": {
      const ring = Math.min(2, Math.max(0.6, length + 0.3));
      const body = gainNode(context, out);
      decay(body.gain, when, ring, event.peak, 0.003);
      oscillator(context, "sine", event, when, end, when + ring + 0.02).connect(body);
      const shine = gainNode(context, out);
      decay(shine.gain, when, ring / 3, event.peak * 0.25, 0.002);
      oscillator(context, "sine", event, when, end, when + ring / 3 + 0.02, 4).connect(shine);
      return;
    }
    case "organ": {
      const envelope = gainNode(context, out);
      sustain(envelope.gain, when, end, event.peak * 0.8, 0.02, Math.min(0.08, length / 3));
      const node = oscillator(context, "sine", event, when, end, end + 0.02);
      node.setPeriodicWave(extrasFor(context).organ);
      node.connect(envelope);
      return;
    }
    case "pluck": {
      const ring = Math.min(1.5, Math.max(0.15, length + 0.1));
      const envelope = gainNode(context, out);
      decay(envelope.gain, when, ring, event.peak, 0.002);
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.setValueAtTime(1, when);
      filter.frequency.setValueAtTime(Math.min(event.freq * 8, 12000), when);
      filter.frequency.exponentialRampToValueAtTime(Math.max(event.freq * 1.2, 60), when + ring / 2);
      filter.connect(envelope);
      oscillator(context, "sawtooth", event, when, end, when + ring + 0.02).connect(filter);
      return;
    }
    case "bass": {
      const envelope = gainNode(context, out);
      sustain(envelope.gain, when, end, event.peak, 0.01, release);
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.setValueAtTime(0.8, when);
      filter.frequency.setValueAtTime(Math.min(event.freq * 3, 1200), when);
      filter.connect(envelope);
      oscillator(context, "square", event, when, end, end + 0.02).connect(filter);
      return;
    }
    case "noise": {
      const edge = Math.min(length / 4, 0.25);
      const envelope = gainNode(context, out);
      sustain(envelope.gain, when, end, event.peak * 2, edge, edge);
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.setValueAtTime(1.2, when);
      filter.frequency.setValueAtTime(event.freq, when);
      if (event.to !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(event.to, end);
      }
      filter.connect(envelope);
      const source = context.createBufferSource();
      source.buffer = extrasFor(context).noise;
      source.loop = true;
      source.connect(filter);
      source.start(when, (serial * 0.173) % noiseSeconds);
      source.stop(end + 0.02);
      return;
    }
  }
}

export function createMusicPlayer(options: MusicPlayerOptions): MusicPlayer {
  const gain = options.gain ?? musicPeakGain;
  const timers = options.timers ?? (globalThis as unknown as MusicTimers);
  let input: MusicTrack | null = null;
  let wanted: Piece | undefined;
  let live: Instance | undefined;
  let fading: Instance[] = [];
  let paused = false;
  let resumeAt = 0;
  let timer: unknown;
  let audio: AudioContextLike | undefined;

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

  const ramp = (instance: Instance, to: number, seconds: number, now: number): void => {
    const from = gainAt(instance, now);
    instance.out.gain.cancelScheduledValues(now);
    instance.out.gain.setValueAtTime(from, now);
    instance.out.gain.linearRampToValueAtTime(to, now + seconds);
    instance.fade = { start: now, end: now + seconds, from, to };
  };

  const fadeOut = (instance: Instance, seconds: number, now: number): void => {
    for (const other of fading) {
      if (other.end === undefined || other.end > now + cutFade) {
        ramp(other, 0, cutFade, now);
        other.end = now + cutFade;
      }
    }
    ramp(instance, 0, seconds, now);
    instance.end = now + seconds;
    fading.push(instance);
  };

  const begin = (audioContext: AudioContextLike, next: Piece, offset: number, fadeIn: number): Instance => {
    const now = audioContext.currentTime;
    const out = gainNode(audioContext, audioContext.destination);
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
    };
  };

  const schedule = (audioContext: AudioContextLike, instance: Instance, now: number): void => {
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
        synthesize(audioContext, instance.out, event, Math.max(when, now), instance.serial);
        instance.serial += 1;
      }
      instance.index += 1;
      if (instance.index >= events.length) {
        instance.index = 0;
        instance.round += 1;
      }
    }
  };

  const tick = (): void => {
    const audioContext = audio;
    if (audioContext !== undefined) {
      const now = audioContext.currentTime;
      fading = fading.filter((instance) => {
        if (instance.end !== undefined && now >= instance.end + lateSeconds) {
          instance.out.disconnect();
          return false;
        }
        schedule(audioContext, instance, now);
        return true;
      });
      if (live !== undefined) {
        schedule(audioContext, live, now);
      }
    }
    if (live === undefined && fading.length === 0 && timer !== undefined) {
      timers.clearInterval(timer);
      timer = undefined;
    } else if ((live !== undefined || fading.length > 0) && timer === undefined) {
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
      const previous = live;
      live = undefined;
      if (previous !== undefined) {
        fadeOut(previous, musicCrossfadeSeconds, audioContext.currentTime);
      }
      if (next !== undefined) {
        live = begin(audioContext, next, 0, previous === undefined ? startFade : musicCrossfadeSeconds);
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
        }
        resumeAt = 0;
      }
      tick();
    },
    tick,
    stop() {
      for (const instance of [...fading, ...(live === undefined ? [] : [live])]) {
        instance.out.disconnect();
      }
      fading = [];
      live = undefined;
      wanted = undefined;
      input = null;
      resumeAt = 0;
      if (timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
