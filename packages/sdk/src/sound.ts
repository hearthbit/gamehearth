export type SoundWave = "square" | "sine" | "triangle" | "sawtooth";

export interface Note {
  freq: number;
  to?: number;
  at?: number;
  length: number;
  wave?: SoundWave;
  volume?: number;
}

export interface SoundNotes {
  notes: readonly Note[];
}

export const soundNames = ["tap", "blip", "select", "move", "coin", "hit", "pop", "start", "tick", "error", "win", "lose"] as const;

export type SoundName = (typeof soundNames)[number];

export type Sound = SoundName | SoundNotes;

export const soundWaves: readonly SoundWave[] = ["square", "sine", "triangle", "sawtooth"];
export const maxSoundNotes = 16;
export const maxSoundSeconds = 2;
export const minSoundFrequency = 30;
export const maxSoundFrequency = 8000;
export const minNoteLength = 0.01;

const presets: Record<SoundName, readonly Note[]> = {
  tap: [{ freq: 660, length: 0.04, volume: 0.35 }],
  blip: [{ freq: 880, length: 0.06 }],
  select: [
    { freq: 660, length: 0.05 },
    { freq: 990, at: 0.05, length: 0.07 },
  ],
  move: [{ freq: 330, to: 220, length: 0.08, wave: "triangle", volume: 0.7 }],
  coin: [
    { freq: 988, length: 0.06 },
    { freq: 1319, at: 0.06, length: 0.2 },
  ],
  hit: [{ freq: 220, to: 90, length: 0.12, wave: "sawtooth", volume: 0.45 }],
  pop: [{ freq: 600, to: 1200, length: 0.06, wave: "sine", volume: 0.8 }],
  start: [
    { freq: 523, length: 0.09 },
    { freq: 659, at: 0.09, length: 0.09 },
    { freq: 784, at: 0.18, length: 0.09 },
    { freq: 1047, at: 0.27, length: 0.18 },
  ],
  tick: [{ freq: 1200, length: 0.02, wave: "sine", volume: 0.3 }],
  error: [
    { freq: 196, length: 0.12 },
    { freq: 147, at: 0.12, length: 0.18 },
  ],
  win: [
    { freq: 523, length: 0.1 },
    { freq: 659, at: 0.1, length: 0.1 },
    { freq: 784, at: 0.2, length: 0.1 },
    { freq: 1047, at: 0.3, length: 0.16 },
    { freq: 784, at: 0.46, length: 0.08 },
    { freq: 1047, at: 0.54, length: 0.36 },
  ],
  lose: [
    { freq: 392, length: 0.16, wave: "triangle", volume: 0.7 },
    { freq: 330, at: 0.16, length: 0.16, wave: "triangle", volume: 0.7 },
    { freq: 262, at: 0.32, length: 0.36, to: 247, wave: "triangle", volume: 0.7 },
  ],
};

export function isSoundName(value: unknown): value is SoundName {
  return typeof value === "string" && (soundNames as readonly string[]).includes(value);
}

export function soundProblem(sound: unknown): string | undefined {
  if (typeof sound === "string") {
    return isSoundName(sound) ? undefined : `${JSON.stringify(sound)} is not a sound of the SDK; known are ${soundNames.join(", ")}, or { notes: [...] } with your own notes.`;
  }
  if (sound === null || typeof sound !== "object" || Array.isArray(sound)) {
    return "A sound is a name such as \"coin\" or { notes: [{ freq: 440, length: 0.1 }] }.";
  }
  const keys = Object.keys(sound);
  if (keys.length !== 1 || keys[0] !== "notes") {
    return "A sound of your own has exactly one field, notes: { notes: [{ freq: 440, length: 0.1 }] }.";
  }
  const notes = (sound as { notes: unknown }).notes;
  if (!Array.isArray(notes) || notes.length === 0 || notes.length > maxSoundNotes) {
    return `notes must be a list of 1 to ${maxSoundNotes} notes.`;
  }
  for (const [index, note] of notes.entries()) {
    const problem = noteProblem(note);
    if (problem !== undefined) {
      return `notes[${index}]: ${problem}`;
    }
  }
  return undefined;
}

function noteProblem(note: unknown): string | undefined {
  if (note === null || typeof note !== "object" || Array.isArray(note)) {
    return "a note is an object such as { freq: 440, length: 0.1 }";
  }
  const record = note as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !["freq", "to", "at", "length", "wave", "volume"].includes(key));
  if (unknown !== undefined) {
    return `unknown field ${unknown}; a note has freq, to, at, length, wave and volume`;
  }
  const frequency = (key: "freq" | "to") =>
    typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= minSoundFrequency && (record[key] as number) <= maxSoundFrequency;
  if (!frequency("freq")) {
    return `freq must be a number of hertz from ${minSoundFrequency} to ${maxSoundFrequency}`;
  }
  if (record["to"] !== undefined && !frequency("to")) {
    return `to must be a number of hertz from ${minSoundFrequency} to ${maxSoundFrequency}`;
  }
  const length = record["length"];
  if (typeof length !== "number" || !Number.isFinite(length) || length < minNoteLength || length > maxSoundSeconds) {
    return `length must be a number of seconds from ${minNoteLength} to ${maxSoundSeconds}`;
  }
  const at = record["at"] ?? 0;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at + length > maxSoundSeconds) {
    return `at must be a number of seconds of at least 0, and the note must end within ${maxSoundSeconds} seconds`;
  }
  if (record["wave"] !== undefined && !(soundWaves as readonly unknown[]).includes(record["wave"])) {
    return `wave must be one of ${soundWaves.join(", ")}`;
  }
  const volume = record["volume"];
  if (volume !== undefined && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1)) {
    return "volume must be a number from 0 to 1";
  }
  return undefined;
}

export function soundNotes(sound: Sound): Note[] {
  const notes = typeof sound === "string" ? presets[sound] : sound.notes;
  return notes.map((note) => ({
    freq: note.freq,
    ...(note.to === undefined ? {} : { to: note.to }),
    at: note.at ?? 0,
    length: note.length,
    wave: note.wave ?? "square",
    volume: note.volume ?? 0.5,
  }));
}

export function readSound(raw: unknown): Sound | undefined {
  if (soundProblem(raw) !== undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw as SoundName;
  }
  return { notes: soundNotes(raw as SoundNotes) };
}
