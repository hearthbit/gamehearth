import { soundNotes, type Sound } from "@gamehearth/sdk/platform";
import { deviceSetting } from "./device-setting";

export const sound = deviceSetting("gamehearth.sound", false);

export type Cue = "tap" | "join" | "start";

interface Note {
  from: number;
  to?: number;
  at: number;
  length: number;
  wave?: OscillatorType;
  volume?: number;
}

export const cues: Record<Cue, readonly Note[]> = {
  tap: [{ from: 660, to: 990, at: 0, length: 0.05, volume: 0.05 }],
  join: [
    { from: 523, at: 0, length: 0.07 },
    { from: 659, at: 0.07, length: 0.07 },
    { from: 784, at: 0.14, length: 0.07 },
    { from: 1047, at: 0.21, length: 0.16 },
  ],
  start: [
    { from: 196, to: 784, at: 0, length: 0.22, wave: "triangle", volume: 0.09 },
    { from: 784, at: 0.26, length: 0.08 },
    { from: 1568, at: 0.36, length: 0.22 },
  ],
};

export const gameSoundGain = 0.12;
export const gameSoundsPerSecond = 12;

interface Tone {
  from: number;
  to?: number | undefined;
  at: number;
  length: number;
  wave: OscillatorType;
  peak: number;
}

type AudioConstructor = new () => AudioContext;

let context: AudioContext | undefined;
let gesture = false;

export function audioContext(): AudioContext | undefined {
  if (context !== undefined) {
    return context;
  }
  const scope = globalThis as { AudioContext?: AudioConstructor; webkitAudioContext?: AudioConstructor };
  const Audio = scope.AudioContext ?? scope.webkitAudioContext;
  if (Audio === undefined) {
    return undefined;
  }
  try {
    context = new Audio();
  } catch {
    return undefined;
  }
  return context;
}

export function unlocked(): boolean {
  if (gesture) {
    return true;
  }
  const navigator = (globalThis as { navigator?: { userActivation?: { hasBeenActive?: boolean } } }).navigator;
  return navigator?.userActivation?.hasBeenActive === true;
}

function playTones(tones: readonly Tone[]): void {
  if (!unlocked() || !sound.get()) {
    return;
  }
  const audio = audioContext();
  if (audio === undefined) {
    return;
  }
  resumeAudio();
  const start = audio.currentTime + 0.01;
  for (const tone of tones) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const begin = start + tone.at;
    const end = begin + tone.length;
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.from, begin);
    if (tone.to !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
    }
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, tone.peak), begin + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(begin);
    oscillator.stop(end + 0.02);
  }
}

export function playCue(cue: Cue): void {
  playTones(cues[cue].map((note) => ({ from: note.from, to: note.to, at: note.at, length: note.length, wave: note.wave ?? "square", peak: note.volume ?? 0.06 })));
}

export function playSound(effect: Sound): void {
  playTones(
    soundNotes(effect).map((note) => ({
      from: note.freq,
      to: note.to,
      at: note.at ?? 0,
      length: note.length,
      wave: note.wave ?? "square",
      peak: (note.volume ?? 0.5) * gameSoundGain,
    })),
  );
}

export function gameSoundPlayer(now: () => number = () => performance.now(), play: (effect: Sound) => void = playSound): (effect: Sound) => void {
  const recent: number[] = [];
  return (effect) => {
    const time = now();
    while (recent.length > 0 && time - (recent[0] as number) >= 1000) {
      recent.shift();
    }
    if (recent.length >= gameSoundsPerSecond) {
      return;
    }
    recent.push(time);
    play(effect);
  };
}

function mainButton(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target.closest("button, a") : null;
  if (element === null || (element instanceof HTMLButtonElement && element.disabled)) {
    return false;
  }
  return element.classList.contains("button") && !["secondary", "ghost", "danger", "quiet"].some((kind) => element.classList.contains(kind));
}

export function installSounds(target: Document = document): () => void {
  const tap = (event: Event) => {
    gesture = true;
    if (mainButton(event.target)) {
      playCue("tap");
    }
  };
  target.addEventListener("pointerdown", noteGesture, { capture: true });
  target.addEventListener("keydown", noteGesture, { capture: true });
  target.addEventListener("click", tap, { capture: true });
  return () => {
    target.removeEventListener("pointerdown", noteGesture, { capture: true });
    target.removeEventListener("keydown", noteGesture, { capture: true });
    target.removeEventListener("click", tap, { capture: true });
  };
}

export function resumeAudio(): void {
  const audio = audioContext();
  if (audio !== undefined && audio.state !== "running" && audio.state !== "closed") {
    void audio.resume().catch(() => undefined);
  }
}

export function noteGesture(): void {
  gesture = true;
}

export function unlockAudio(): void {
  gesture = true;
  resumeAudio();
}

export function toggleSound(on: boolean): void {
  if (on) {
    gesture = true;
  }
  sound.set(on);
  if (on) {
    playCue("tap");
  }
}
